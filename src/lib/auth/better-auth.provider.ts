import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { getEnv } from "@/config/env";
import { getPrisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logging/logger";
import type { Env } from "@/config/env";
import type { AuthProvider, AuthSession } from "./provider";

/**
 * Origins allowed to call the auth API.
 *
 * Production stays strict: only APP_URL plus explicitly configured origins.
 * Development additionally trusts any localhost port, because Next.js picks a
 * free port whenever 3000 is busy.
 */
function resolveTrustedOrigins(env: Env): string[] {
  const origins = new Set<string>([env.APP_URL]);
  for (const origin of env.BETTER_AUTH_TRUSTED_ORIGINS.split(",")) {
    const trimmed = origin.trim();
    if (trimmed !== "") {
      origins.add(trimmed);
    }
  }
  if (env.NODE_ENV !== "production") {
    origins.add("http://localhost:*");
    origins.add("http://127.0.0.1:*");
  }
  return [...origins];
}

/**
 * Constructed lazily so importing this module never reads env or opens
 * sockets (important during build-time module evaluation).
 */
function createAuthInstance() {
  const env = getEnv();
  const instance = betterAuth({
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
