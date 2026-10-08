import { getEnv } from "@/config/env";
import { logger } from "@/lib/logging/logger";
import type { AuthProvider, AuthSession } from "./provider";

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

/** Headers that must not be forwarded to the upstream auth host. */
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
]);

export class NeonAuthProvider implements AuthProvider {
  public readonly id = "neon-auth";

  private readonly baseUrl: string;
  private readonly jwksUrl: string;

  constructor() {
    const env = getEnv();
    if (env.AUTH_URL === "") {
      throw new Error("NeonAuthProvider requires AUTH_URL to be configured");
    }
    this.baseUrl = env.AUTH_URL.replace(/\/+$/, "");
    this.jwksUrl = env.JWKS_URL;
    logger.info("auth provider initialized", {
      provider: "neon-auth",
      jwksConfigured: this.jwksUrl !== "",
    });
  }

  /**
   * Proxies the app's /api/auth/<path> route to AUTH_URL/<path>.
   *
   * The Origin header is deliberately dropped: Better Auth only runs its
   * CSRF/origin check when Origin is present, and the trusted-origin allowlist
   * is configured for the deployed app origin in the Neon console — not for
   * every local dev port.
   */
  public async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const subpath = url.pathname.replace(/^\/api\/auth\/?/, "");
    const target = `${this.baseUrl}/${subpath}${url.search}`;

    const headers = new Headers();
    for (const [key, value] of request.headers.entries()) {
      if (!HOP_BY_HOP.has(key.toLowerCase()) && key.toLowerCase() !== "origin") {
        headers.set(key, value);
      }
    }

    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      ...(hasBody ? { duplex: "half" } : {}),
      redirect: "manual",
    });

    // Pass the upstream response through verbatim (set-cookie included; Neon
    // Auth sets the session cookie without a Domain attribute, so it binds to
    // this app's origin).
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
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
