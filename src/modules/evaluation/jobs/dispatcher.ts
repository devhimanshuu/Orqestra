/**
 * Evaluation dispatcher — mirrors the run dispatcher.
 *
 *   queue  → BullMQ jobs, consumed by the worker (`pnpm worker`)
 *   inline → executed in this process, fire-and-forget (development, tests,
 *            single-process deployments without Redis)
 *   auto   → queue when Redis answers, inline otherwise (default)
 *
 * `RUN_EXECUTION_MODE` selects the mode, so a deployment configures evaluation
 * transport the same way it configures run transport. Either way the *same*
 * orchestrator runs; only the transport differs, and the chosen mode is
 * reported back so the caller can say where the work went.
 */

import { getEnv } from "@/config/env";
import { logger } from "@/lib/logging/logger";
import { pingRedis } from "@/lib/redis/connection";
import { enqueueEvaluationBatch } from "./queues";
import { runEvaluationBatch } from "./orchestrator";

const dispatcherLogger = logger.child({ module: "evaluation.dispatcher" });

export type EvaluationDispatchMode = "queue" | "inline";

export interface EvaluationDispatchResult {
  mode: EvaluationDispatchMode;
  jobId: string | null;
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

function startInline(batchId: string): void {
  void runEvaluationBatch(batchId, { transport: "inline" }).catch((error: unknown) => {
    dispatcherLogger.error("inline evaluation batch failed", {
      batchId,
      message: error instanceof Error ? error.message : String(error),
    });
  });
}

export async function dispatchEvaluationBatch(batchId: string): Promise<EvaluationDispatchResult> {
  const configured = getEnv().RUN_EXECUTION_MODE;

  if (configured === "inline") {
    startInline(batchId);
    return { mode: "inline", jobId: null };
  }

  if (configured === "queue") {
    const jobId = await enqueueEvaluationBatch(batchId);
    return { mode: "queue", jobId };
  }

  // auto
  if (await redisReachable()) {
    try {
      const jobId = await enqueueEvaluationBatch(batchId);
      return { mode: "queue", jobId };
    } catch (error) {
      dispatcherLogger.warn("evaluation enqueue failed — falling back to inline execution", {
        batchId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    dispatcherLogger.debug("redis unavailable — running evaluation inline", { batchId });
  }

  startInline(batchId);
  return { mode: "inline", jobId: null };
}
