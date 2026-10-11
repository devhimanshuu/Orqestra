import { Worker } from "bullmq";
import { createBullConnection } from "@/lib/redis/connection";
import { logger } from "@/lib/logging/logger";
import { EVALUATION_QUEUE_NAME, evaluationJobSchema, type EvaluationJobData } from "./queues";
import { runEvaluationBatch, runEvaluationCaseJob } from "./orchestrator";
import type { EvaluationJobOutcome } from "./types";

/**
 * Evaluation queue worker.
 *
 * Started by the same `pnpm worker` process as the run worker (see
 * runtime/worker.ts), so a deployment runs one worker binary for both queues.
 *
 * The processor is a thin adapter: validate the payload, then hand off to the
 * orchestrator. Everything long-running happens here, never in an HTTP request.
 */

const workerLogger = logger.child({ module: "evaluation.worker" });

export async function processEvaluationJob(data: EvaluationJobData): Promise<EvaluationJobOutcome> {
  const job = evaluationJobSchema.parse(data);

  if (job.kind === "batch") {
    workerLogger.info("evaluation batch job picked up", { batchId: job.batchId });
    const summary = await runEvaluationBatch(job.batchId, { transport: "queue" });
    return { kind: "batch", summary };
  }

  workerLogger.info("evaluation case job picked up", {
    batchId: job.batchId,
    caseKey: job.caseKey,
  });
  const result = await runEvaluationCaseJob(job.batchId, job.caseKey);
  return { kind: "case", status: result.status };
}

export function startEvaluationWorker() {
  const worker = new Worker<EvaluationJobData>(
    EVALUATION_QUEUE_NAME,
    async (job) => processEvaluationJob(job.data),
    {
      connection: createBullConnection(),
      // Case-level parallelism lives in the batch's own concurrency setting;
      // the queue runs few batches at once so the two do not multiply.
      concurrency: 2,
      lockDuration: 300_000,
      stalledInterval: 60_000,
    },
  );

  worker.on("ready", () => workerLogger.info("evaluation worker ready", { queue: EVALUATION_QUEUE_NAME }));
  worker.on("failed", (job, error) => {
    workerLogger.error("evaluation job failed", { jobId: job?.id, message: error.message });
  });
  worker.on("error", (error) => {
    workerLogger.warn("evaluation worker error", { message: error.message });
  });

  return worker;
}
