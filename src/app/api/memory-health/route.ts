import { requireApiUser } from "@/lib/auth/api-session";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { jsonOk } from "@/lib/http/api-response";
import { pingRedis, getRedisInfo } from "@/lib/redis/connection";
import { getHealthReport } from "@/lib/health/health.service";

/**
 * GET /api/memory-health — Redis connection status, latency, and memory stats.
 * Requires authentication; safe to expose to authenticated users only.
 */
export async function GET(): Promise<Response> {
  try {
    await requireApiUser();

    const startedAt = performance.now();
    let redisStatus: "connected" | "disconnected" | "timeout" = "disconnected";
    let latencyMs: number | null = null;
    let redisError: string | null = null;

    try {
      latencyMs = await Promise.race([
        pingRedis(5_000),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 5_000),
        ),
      ]);
      redisStatus = "connected";
    } catch (err) {
      redisError = err instanceof Error ? err.message : String(err);
      redisStatus = redisError === "timeout" ? "timeout" : "disconnected";
    }

    const elapsed = Math.round(performance.now() - startedAt);

    // Get Redis INFO memory section if connected
    let memoryInfo: Record<string, string> | null = null;
    if (redisStatus === "connected") {
      try {
        const info = await getRedisInfo("memory");
        memoryInfo = info;
      } catch {
        // Non-fatal: memory info unavailable
      }
    }

    // Also get overall health for context
    const health = await getHealthReport();

    return jsonOk({
      redis: {
        status: redisStatus,
        latencyMs,
        error: redisError,
        memory: memoryInfo,
      },
      overall: health.status,
      services: health.services,
      checkedAt: new Date().toISOString(),
      checkDurationMs: elapsed,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
