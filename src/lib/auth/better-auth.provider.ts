import { betterAuth, type BetterAuthOptions } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { getEnv, type Env } from "@/config/env";
import { getPrisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logging/logger";
import type { AuthProvider, AuthSession } from "./provider";
import { resolveTrustedOrigins } from "./trusted-origins";

/**
 * Constructed lazily so importing this module never reads env or opens
 * sockets (important during build-time module evaluation).
 */
/**
 * Social sign-in is opt-in per provider: both OAuth halves must be present —
 * an ID without a secret would enable a provider that can only fail at the
 * redirect. Returns undefined when nothing is configured, so the self-hosted
 * instance keeps a single auth method until credentials arrive.
 */
function socialProvidersFor(
  env: Env,
): NonNullable<BetterAuthOptions["socialProviders"]> | undefined {
  const providers: NonNullable<BetterAuthOptions["socialProviders"]> = {};
  if (env.GITHUB_CLIENT_ID !== "" && env.GITHUB_CLIENT_SECRET !== "") {
    providers.github = { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET };
  }
  if (env.GOOGLE_CLIENT_ID !== "" && env.GOOGLE_CLIENT_SECRET !== "") {
    providers.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  }
  return Object.keys(providers).length > 0 ? providers : undefined;
}

function createAuthInstance() {
  const env = getEnv();
  const socialProviders = socialProvidersFor(env);
  const instance = betterAuth({
    /*
     * With AUTH_URL set, /api/auth/* is proxied to Neon's hosted instance and
     * its own provider configuration wins — these local values only configure
     * the self-hosted fallback.
     */
    ...(socialProviders !== undefined ? { socialProviders } : {}),
    baseURL: env.APP_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: prismaAdapter(getPrisma(), { provider: "postgresql" }),
    trustedOrigins: resolveTrustedOrigins(env),
    plugins: [nextCookies()],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // refresh daily
    },
    telemetry: { enabled: false },
  });
  logger.info("auth provider initialized", { provider: "better-auth" });
  return instance;
}

type AuthInstance = ReturnType<typeof createAuthInstance>;

/**
 * Better Auth implementation of the AuthProvider abstraction.
 * Everything above the line (services, pages, routes) sees only the interface.
 */
export class BetterAuthProvider implements AuthProvider {
  public readonly id = "better-auth";

  private instance: AuthInstance | null = null;

  private getInstance(): AuthInstance {
    if (this.instance === null) {
      this.instance = createAuthInstance();
    }
    return this.instance;
  }

  public async handleRequest(request: Request): Promise<Response> {
    return this.getInstance().handler(request);
  }

  public async getSession(headers: Headers): Promise<AuthSession | null> {
    const result = await this.getInstance().api.getSession({ headers });
    if (result === null) {
      return null;
    }
    return {
      user: {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        emailVerified: result.user.emailVerified,
        createdAt: result.user.createdAt,
      },
      session: {
        id: result.session.id,
        expiresAt: result.session.expiresAt,
      },
    };
  }
}
