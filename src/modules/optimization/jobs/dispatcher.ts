/**
 * Optimization dispatcher — mirrors the run, evaluation and experiment
 * dispatchers, for the same reason: an optimization pass is long-running and must
 * not live inside an HTTP request.
 *
 *   queue  → BullMQ jobs, consumed by the worker (`pnpm worker`)
 *   inline → executed in this process, fire-and-forget
 *   auto   → queue when Redis answers, inline otherwise (default)
 *
 * Either way the *same* orchestrator runs; only the transport differs.
 */

import { getEnv } from "@/config/env";
import { logger } from "@/lib/logging/logger";
import { pingRedis } from "@/lib/redis/connection";
import { enqueueOptimization } from "./queues";
import { runOptimizationJob } from "./orchestrator";

const dispatcherLogger = logger.child({ module: "optimization.dispatcher" });

export type OptimizationDispatchMode = "queue" | "inline";

export interface OptimizationDispatchResult {
  mode: OptimizationDispatchMode;
  jobId: string | null;
  nonce: string;
}

const REDIS_PROBE_TIMEOUT_MS = 1_500;

async function redisReachable(): Promise<boolean> {
  try {
    await pingRedis(REDIS_PROBE_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

function startInline(sessionId: string, nonce: string): void {
  void runOptimizationJob(sessionId, { transport: "inline", nonce }).catch((error: unknown) => {
    dispatcherLogger.error("inline optimization run failed", {
      sessionId,
      message: error instanceof Error ? error.message : String(error),
    });
  });
}

export async function dispatchOptimization(sessionId: string): Promise<OptimizationDispatchResult> {
  const configured = getEnv().RUN_EXECUTION_MODE;
  const nonce = `p${Date.now().toString(36)}`;

  if (configured === "inline") {
    startInline(sessionId, nonce);
    return { mode: "inline", jobId: null, nonce };
  }

  if (configured === "queue") {
    const jobId = await enqueueOptimization(sessionId, nonce);
    return { mode: "queue", jobId, nonce };
  }

  if (await redisReachable()) {
    try {
      const jobId = await enqueueOptimization(sessionId, nonce);
      return { mode: "queue", jobId, nonce };
    } catch (error) {
      dispatcherLogger.warn("optimization enqueue failed; running inline", {
        sessionId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  startInline(sessionId, nonce);
  return { mode: "inline", jobId: null, nonce };
}
