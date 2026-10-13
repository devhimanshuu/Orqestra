/**
 * Experiment dispatcher — mirrors the run and evaluation dispatchers.
 *
 *   queue  → BullMQ jobs, consumed by the worker (`pnpm worker`)
 *   inline → executed in this process, fire-and-forget (development, tests,
 *            single-process deployments without Redis)
 *   auto   → queue when Redis answers, inline otherwise (default)
 *
 * `RUN_EXECUTION_MODE` selects the mode, so a deployment configures experiment
 * transport the same way it configures run transport. Either way the *same*
 * orchestrator runs; only the transport differs, and the mode is reported back so
 * the caller can say where the work went.
 */

import { getEnv } from "@/config/env";
import { logger } from "@/lib/logging/logger";
import { pingRedis } from "@/lib/redis/connection";
import { enqueueExperiment } from "./queues";
import { runExperimentJob } from "./orchestrator";

const dispatcherLogger = logger.child({ module: "experiments.dispatcher" });

export type ExperimentDispatchMode = "queue" | "inline";

export interface ExperimentDispatchResult {
  mode: ExperimentDispatchMode;
  jobId: string | null;
  /** The nonce that identifies this pass (resumes get a fresh one). */
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

function startInline(experimentId: string, nonce: string): void {
  void runExperimentJob(experimentId, { transport: "inline", nonce }).catch((error: unknown) => {
    dispatcherLogger.error("inline experiment run failed", {
      experimentId,
      message: error instanceof Error ? error.message : String(error),
    });
  });
}

export async function dispatchExperiment(experimentId: string): Promise<ExperimentDispatchResult> {
  const configured = getEnv().RUN_EXECUTION_MODE;
  const nonce = `p${Date.now().toString(36)}`;

  if (configured === "inline") {
    startInline(experimentId, nonce);
    return { mode: "inline", jobId: null, nonce };
  }

  if (configured === "queue") {
    const jobId = await enqueueExperiment(experimentId, nonce);
    return { mode: "queue", jobId, nonce };
  }

  // auto
  if (await redisReachable()) {
    try {
      const jobId = await enqueueExperiment(experimentId, nonce);
      return { mode: "queue", jobId, nonce };
    } catch (error) {
      dispatcherLogger.warn("experiment enqueue failed — falling back to inline execution", {
        experimentId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    dispatcherLogger.debug("redis unavailable — running the experiment inline", { experimentId });
  }

  startInline(experimentId, nonce);
  return { mode: "inline", jobId: null, nonce };
}
