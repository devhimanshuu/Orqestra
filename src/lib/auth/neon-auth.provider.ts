import { getEnv } from "@/config/env";
import { logger } from "@/lib/logging/logger";
import type { AuthProvider, AuthSession } from "./provider";
import { isOriginTrusted, resolveTrustedOrigins } from "./trusted-origins";

/**
 * Neon Auth implementation of the AuthProvider abstraction.
 *
 * Neon Auth is Better Auth hosted by Neon on the same database: users,
 * sessions, accounts, and verification rows live in our tables, but the auth
 * server itself runs at `AUTH_URL`. This provider therefore:
 *
 *  - proxies every `/api/auth/*` request to `AUTH_URL/<subpath>` (sign-up,
 *    sign-in, sign-out, session endpoints) — the app stays same-origin for
 *    the browser, so cookies work without extra configuration;
 *  - resolves server-side sessions by forwarding the request cookies to
 *    `AUTH_URL/get-session`, which returns the standard Better Auth shape.
 *
 * `JWKS_URL` (EdDSA keys) is intentionally *not* used for verification yet —
 * forwarding cookies is the documented integration and cannot drift from the
 * hosted instance's session semantics. It is validated at startup for the
 * future stateless-token path.
 */

interface NeonSessionPayload {
  user?: {
    id: string;
    email: string;
    name: string;
    emailVerified: boolean;
    createdAt: string | Date;
  };
  session?: {
    id: string;
    expiresAt: string | Date;
  };
}

/**
 * Headers that must not be forwarded to the upstream auth host:
 *
 *  - hop-by-hop headers, which describe this server's connection; and
 *  - request-scoped forwarding headers added by the app's own edge
 *    (`x-forwarded-*` and friends). They describe the hop *into this app*, and
 *    Neon's edge reads them as its own: an `x-forwarded-proto: http` makes it
 *    answer with a 308 to the HTTPS URL instead of the API response, and a
 *    foreign `x-forwarded-host` yields a 400.
 */
const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-real-ip",
  "x-vercel-id",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
]);

export class NeonAuthProvider implements AuthProvider {
  public readonly id = "neon-auth";

  private readonly baseUrl: string;
  private readonly jwksUrl: string;
  /** Canonical app origin — the one registered as trusted with the hosted instance. */
  private readonly appOrigin: string;
  private readonly trustedOrigins: readonly string[];

  constructor() {
    const env = getEnv();
    if (env.AUTH_URL === "") {
      throw new Error("NeonAuthProvider requires AUTH_URL to be configured");
    }
    this.baseUrl = env.AUTH_URL.replace(/\/+$/, "");
    this.jwksUrl = env.JWKS_URL;
    this.appOrigin = env.APP_URL;
    this.trustedOrigins = resolveTrustedOrigins(env);
    logger.info("auth provider initialized", {
      provider: "neon-auth",
      jwksConfigured: this.jwksUrl !== "",
    });
  }

  /**
   * Proxies the app's /api/auth/<path> route to AUTH_URL/<path>.
   *
   * Origin handling: the hosted instance rejects state-changing requests that
   * arrive without an Origin header ("Missing or null Origin") and validates
   * it against the origins registered for the project. Browsers send this
   * app's own origin, which the hosted instance cannot know about (dev ports,
   * preview URLs), so the proxy
   *
   *   1. validates the incoming Origin against the same allowlist the
   *      self-hosted provider uses (loopback wildcards only outside
   *      production), rejecting untrusted origins with 403; and
   *   2. rewrites it to APP_URL — the canonical origin registered upstream.
   *
   * Non-browser callers (seed scripts, curl) send no Origin; they are treated
   * as state-changing server-to-server calls and get the same rewrite.
   * Referer is dropped for the same reason: the hosted instance falls back to
   * it when Origin is absent, and a dev-port Referer would fail the check.
   */
  public async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const subpath = url.pathname.replace(/^\/api\/auth\/?/, "");
    const target = `${this.baseUrl}/${subpath}${url.search}`;
    const isSafeMethod =
      request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS";

    const incomingOrigin = request.headers.get("origin");
    let upstreamOrigin: string | null = null;
    if (incomingOrigin !== null && incomingOrigin !== "") {
      // Same-origin is derived from the Host header, not from `request.url`:
      // Next reconstructs the URL from its own bind address, which differs
      // from the host the browser actually used (e.g. 127.0.0.1 vs localhost).
      const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
      const requestOrigin = `${proto}://${request.headers.get("host") ?? url.host}`;
      const sameOrigin = incomingOrigin === requestOrigin;
      if (!sameOrigin && !isOriginTrusted(incomingOrigin, this.trustedOrigins)) {
        logger.warn("auth proxy rejected request from untrusted origin", {
          origin: incomingOrigin,
          requestOrigin,
        });
        return Response.json({ error: "Origin not allowed" }, { status: 403 });
      }
      upstreamOrigin = this.appOrigin;
    } else if (!isSafeMethod) {
      upstreamOrigin = this.appOrigin;
    }

    const headers = new Headers();
    for (const [key, value] of request.headers.entries()) {
      const name = key.toLowerCase();
      const isEdgeHeader = name.startsWith("x-vercel-") || name.startsWith("cf-");
      if (HOP_BY_HOP.has(name) || isEdgeHeader || name === "origin" || name === "referer") {
        continue;
      }
      headers.set(key, value);
    }
    if (upstreamOrigin !== null) {
      headers.set("origin", upstreamOrigin);
    }

    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      ...(hasBody ? { duplex: "half" } : {}),
      redirect: "manual",
    });

    // Pass the upstream response through (set-cookie included; Neon Auth sets
    // the session cookie without a Domain attribute, so it binds to this app's
    // origin). Redirects are the exception: Better Auth builds Location from
    // the forwarded Host and its own base path, which would send the browser
    // cross-origin and trip CORS — so auth redirects are rewritten back to this
    // app's /api/auth/* mount and stay same-origin.
    const responseHeaders = new Headers(upstream.headers);
    if (upstream.status >= 300 && upstream.status < 400) {
      const location = responseHeaders.get("location");
      if (location !== null) {
        const rewritten = this.rewriteRedirectLocation(location, new URL(request.url).origin);
        if (rewritten !== null) {
          responseHeaders.set("location", rewritten);
        }
      }
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  }

  /**
   * Maps an upstream auth redirect onto this app's /api/auth mount.
   * Returns null when the location does not point at the upstream auth base
   * path (non-auth redirects pass through untouched).
   */
  private rewriteRedirectLocation(location: string, requestOrigin: string): string | null {
    let url: URL;
    try {
      url = new URL(location, this.baseUrl);
    } catch {
      return null;
    }
    const basePath = new URL(this.baseUrl).pathname.replace(/\/+$/, "");
    if (basePath === "" || !url.pathname.startsWith(basePath)) {
      return null;
    }
    const subpath = url.pathname.slice(basePath.length);
    return `${requestOrigin}/api/auth${subpath}${url.search}`;
  }

  public async getSession(headers: Headers): Promise<AuthSession | null> {
    const cookie = headers.get("cookie");
    if (cookie === null || cookie === "") {
      return null;
    }
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/get-session`, {
        headers: { cookie },
      });
    } catch (error) {
      logger.warn("neon auth: get-session request failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json().catch(() => null)) as NeonSessionPayload | null;
    if (payload === null || payload.user === undefined || payload.session === undefined) {
      return null;
    }
    return {
      user: {
        id: payload.user.id,
        email: payload.user.email,
        name: payload.user.name,
        emailVerified: payload.user.emailVerified,
        createdAt: new Date(payload.user.createdAt),
      },
      session: {
        id: payload.session.id,
        expiresAt: new Date(payload.session.expiresAt),
      },
    };
  }
}
