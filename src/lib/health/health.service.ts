import { EnvironmentValidationError, validateEnv } from "@/config/env";
import { getPrisma } from "@/lib/db/prisma";
import { pingRedis } from "@/lib/redis/connection";
import { logger } from "@/lib/logging/logger";
import type { ServiceStatus, HealthReport } from "@/types/health";

export type { HealthReport, HealthReportStatus, ServiceStatus } from "@/types/health";

const CHECK_TIMEOUT_MS = 3_000;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

interface CheckResult {
  status: ServiceStatus;
  latencyMs: number | null;
  error?: string;
}

async function checkDatabase(): Promise<CheckResult> {
  const startedAt = performance.now();
  try {
    await withTimeout(getPrisma().$queryRaw`SELECT 1`, CHECK_TIMEOUT_MS);
    return { status: "healthy", latencyMs: Math.round(performance.now() - startedAt) };
  } catch (error) {
    return {
      status: "unhealthy",
      latencyMs: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkRedis(): Promise<CheckResult> {
  try {
    const latencyMs = await withTimeout(pingRedis(CHECK_TIMEOUT_MS), CHECK_TIMEOUT_MS + 500);
    return { status: "healthy", latencyMs };
  } catch (error) {
    return {
      status: "unhealthy",
      latencyMs: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function checkEnvironment(): { status: ServiceStatus; error?: string } {
  try {
    validateEnv(process.env);
    return { status: "healthy" };
  } catch (error) {
    if (error instanceof EnvironmentValidationError) {
      // Names only — never echo values.
      return { status: "unhealthy", error: error.issues.join("; ") };
    }
    return { status: "unhealthy", error: "environment validation failed" };
  }
}

/**
 * Aggregate health of the Phase 0 stack: application, environment,
 * database, redis. Safe to expose publicly: no secrets, no connection strings.
 */
export async function getHealthReport(): Promise<HealthReport> {
  const [database, redis] = await Promise.all([checkDatabase(), checkRedis()]);
  const environment = checkEnvironment();

  const services: HealthReport["services"] = {
    application: "healthy",
    environment: environment.status,
    database: database.status,
    redis: redis.status,
  };

  const errors: HealthReport["errors"] = {};
  if (environment.error !== undefined) {
    errors.environment = environment.error;
  }
  if (database.error !== undefined) {
    errors.database = database.error;
  }
  if (redis.error !== undefined) {
    errors.redis = redis.error;
  }

  const allHealthy = Object.values(services).every((status) => status === "healthy");
  const report: HealthReport = {
    status: allHealthy ? "healthy" : "degraded",
    timestamp: new Date().toISOString(),
    services,
    latencyMs: {
      database: database.status === "healthy" ? database.latencyMs : null,
      redis: redis.status === "healthy" ? redis.latencyMs : null,
    },
    errors,
  };

  if (!allHealthy) {
    logger.warn("health check degraded", { services, errors });
  }
  return report;
}
