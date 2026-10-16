import { Worker } from "bullmq";
import { createBullConnection } from "@/lib/redis/connection";
import { logger } from "@/lib/logging/logger";
import { OPTIMIZATION_QUEUE_NAME, optimizationJobSchema, type OptimizationJobData } from "./queues";
import { runOptimizationJob } from "./orchestrator";
import type { OptimizationJobOutcome } from "./types";

/**
 * Optimization queue worker.
 *
 * Started by the same `pnpm worker` process as the run, evaluation and experiment
 * workers (see runtime/worker.ts), so a deployment runs one worker binary.
 *
 * Concurrency is 1: an optimization pass creates evaluation batches and executes
 * their cases itself, so running two passes of the *same* session concurrently
 * would contend for providers without making the comparison clearer. Two
 * different sessions may not run at once either — the queue's single slot keeps
 * agent-run usage attributable to the session that caused it.
 *
 * Delivery semantics: the pass claims the session with a conditional update
 * before doing anything, so a redelivered job finds it already claimed and
 * returns without touching a single case.
 */

const workerLogger = logger.child({ module: "optimization.worker" });

export async function processOptimizationJob(
  data: OptimizationJobData,
): Promise<OptimizationJobOutcome> {
  const job = optimizationJobSchema.parse(data);
  workerLogger.info("optimization job picked up", {
    sessionId: job.sessionId,
    nonce: job.nonce,
  });

  const summary = await runOptimizationJob(job.sessionId, {
    transport: "queue",
    nonce: job.nonce,
  });

  workerLogger.info("optimization job finished", {
    sessionId: job.sessionId,
    claimed: summary.claimed,
    status: summary.status,
    iterations: summary.iterations,
    accepted: summary.accepted,
    rejected: summary.rejected,
    stopReason: summary.stopReason,
  });
  return { kind: "optimization", summary };
}

export function startOptimizationWorker() {
  const worker = new Worker<OptimizationJobData>(
    OPTIMIZATION_QUEUE_NAME,
    async (job) => processOptimizationJob(job.data),
    {
      connection: createBullConnection(),
      concurrency: 1,
      // A pass can spend minutes evaluating candidates; renew the lock rather than
      // let a long pass be redelivered to another worker.
      lockDuration: 600_000,
    },
  );

  worker.on("failed", (job, error) => {
    workerLogger.error("optimization job failed", {
      jobId: job?.id ?? null,
      sessionId: job?.data.sessionId ?? null,
      message: error.message,
    });
  });
  worker.on("error", (error) => {
    workerLogger.warn("optimization worker error", { message: error.message });
  });
  workerLogger.info("optimization worker started", { queue: OPTIMIZATION_QUEUE_NAME });
  return worker;
}
