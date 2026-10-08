/**
 * Next.js instrumentation hook — runs once when a server instance starts,
 * before the server accepts requests.
 *
 * Environment validation happens here and nowhere else at startup, so a
 * misconfigured deployment fails immediately with an explicit list of
 * problems instead of failing later inside a request.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { getEnv, EnvironmentValidationError } = await import("@/config/env");
  const { logger } = await import("@/lib/logging/logger");

  try {
    const env = getEnv();
    logger.info("startup: environment validated", {
      nodeEnv: env.NODE_ENV,
      appUrl: env.APP_URL,
      logLevel: env.LOG_LEVEL,
    });

    // Warm the infrastructure clients so the first request does not pay for
    // connection setup. Failures surface through /api/health rather than here.
    const { getPrisma } = await import("@/lib/db/prisma");
    const { getRedis } = await import("@/lib/redis/connection");
    getPrisma();
    getRedis();
  } catch (error) {
    if (error instanceof EnvironmentValidationError) {
      logger.error("startup: environment validation failed", { issues: error.issues });
      // Refuse to start a half-configured server.
      throw error;
    }
    throw error;
  }
}
