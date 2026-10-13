import { Worker } from "bullmq";
import { createBullConnection } from "@/lib/redis/connection";
import { logger } from "@/lib/logging/logger";
import { EXPERIMENT_QUEUE_NAME, experimentJobSchema, type ExperimentJobData } from "./queues";
import { runExperimentJob } from "./orchestrator";
import type { ExperimentJobOutcome } from "./types";

/**
 * Experiment queue worker.
 *
 * Started by the same `pnpm worker` process as the run and evaluation workers
 * (see runtime/worker.ts), so a deployment runs one worker binary for all three
 * queues. The experiment queue is the *outer* orchestration: it decides when each
 * (candidate, case) execution happens and delegates the execution itself to the
 * evaluation case runner, which executes the run in this same process.
 *
 * The processor is a thin adapter: validate the payload, hand off, log the
 * outcome. Everything long-running happens here, never in an HTTP request.
 *
 * Delivery semantics: a pass claims the experiment atomically before doing any
 * work, and every case is claimed with a conditional update, so a redelivered job
 * (or a duplicated one) cannot execute a case twice.
 */

const workerLogger = logger.child({ module: "experiments.worker" });

export async function processExperimentJob(data: ExperimentJobData): Promise<ExperimentJobOutcome> {
  const job = experimentJobSchema.parse(data);
  workerLogger.info("experiment job picked up", {
    experimentId: job.experimentId,
    nonce: job.nonce,
  });

  const summary = await runExperimentJob(job.experimentId, {
    transport: "queue",
    nonce: job.nonce,
  });

  workerLogger.info("experiment job finished", {
    experimentId: job.experimentId,
    claimed: summary.claimed,
    status: summary.status,
    completed: summary.completed,
    failed: summary.failed,
  });
  return { kind: "experiment", summary };
}

export function startExperimentWorker() {
  const worker = new Worker<ExperimentJobData>(
    EXPERIMENT_QUEUE_NAME,
    async (job) => processExperimentJob(job.data),
    {
      connection: createBullConnection(),
      // One experiment per worker slot: an experiment already interleaves its own
      // candidates, so a second concurrent experiment would contend for providers
      // without producing comparable conditions.
      concurrency: 1,
      // An experiment pass can legitimately run for a long time; BullMQ's default
      // lock duration is far shorter, so renew the lock instead of letting a long
      // pass be redelivered to another worker.
      lockDuration: 600_000,
      stalledInterval: 120_000,
    },
  );

  worker.on("ready", () =>
    workerLogger.info("experiment worker ready", { queue: EXPERIMENT_QUEUE_NAME }),
  );
  worker.on("failed", (job, error) => {
    workerLogger.error("experiment job failed", { jobId: job?.id, message: error.message });
  });
  worker.on("error", (error) => {
    workerLogger.warn("experiment worker error", { message: error.message });
  });

  return worker;
}
