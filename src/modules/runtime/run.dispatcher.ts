/**
 * Run dispatcher.
 *
 * Execution never happens inside an HTTP request. The dispatcher picks *where*
 * the job runs:
 *
 *   queue   → BullMQ job, consumed by `pnpm worker` (production default)
 *   inline  → executed in this process, fire-and-forget (development, tests,
 *             and single-process deployments without Redis)
 *   auto    → queue when Redis answers, inline otherwise (default)
 *
 * `RUN_EXECUTION_MODE` selects the mode. Auto exists so a developer without
 * Redis still gets a working runtime: the same executor runs, only the transport
 * differs. The chosen mode is recorded on the run's metadata for reproducibility.
 */

import { getEnv } from "@/config/env";
import { logger } from "@/lib/logging/logger";
import { pingRedis } from "@/lib/redis/connection";
import { enqueueRun } from "./queues";
import { executeRun } from "./run.executor";

const dispatcherLogger = logger.child({ module: "runtime.dispatcher" });

export type DispatchMode = "queue" | "inline";

export interface DispatchResult {
  mode: DispatchMode;
  jobId: string | null;
}

const REDIS_PROBE_TIMEOUT_MS = 1_500;

/** True when Redis answers a ping within the probe budget. */
async function redisReachable(): Promise<boolean> {
  try {
    await pingRedis(REDIS_PROBE_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

/** Executes the run in this process; failures are logged, never thrown upstream. */
function startInline(runId: string): void {
  void executeRun(runId, { transport: "inline" }).catch((error: unknown) => {
    dispatcherLogger.error("inline run execution failed", {
      runId,
      message: error instanceof Error ? error.message : String(error),
    });
  });
}

export async function dispatchRun(runId: string, harnessVersionId: string): Promise<DispatchResult> {
  const configured = getEnv().RUN_EXECUTION_MODE;

  if (configured === "inline") {
    startInline(runId);
    return { mode: "inline", jobId: null };
  }

  if (configured === "queue") {
    const jobId = await enqueueRun({ runId, harnessVersionId });
    return { mode: "queue", jobId };
  }

  // auto
  if (await redisReachable()) {
    try {
      const jobId = await enqueueRun({ runId, harnessVersionId });
      return { mode: "queue", jobId };
    } catch (error) {
      dispatcherLogger.warn("queue enqueue failed — falling back to inline execution", {
        runId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    dispatcherLogger.debug("redis unavailable — executing inline", { runId });
  }

  startInline(runId);
  return { mode: "inline", jobId: null };
}
