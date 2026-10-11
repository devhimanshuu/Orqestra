import { Queue } from "bullmq";
import { z } from "zod";
import { createBullConnection } from "@/lib/redis/connection";
import { logger } from "@/lib/logging/logger";

/**
 * Evaluation queue.
 *
 * Two job kinds, deliberately:
 *
 *   batch — orchestrates a whole evaluation: fan out cases, respect the
 *           batch's concurrency, settle the batch at the end;
 *   case  — executes exactly one test case (run + evaluate + persist).
 *
 * The split matters for reliability: a case job is small, idempotent and
 * individually retryable, while the batch job is long-lived but does almost no
 * work itself. Job ids are derived from the payload, so re-enqueueing the same
 * batch or case is a no-op rather than a duplicate.
 */

export const EVALUATION_QUEUE_NAME = "orqestra.evaluations";

export const evaluationJobSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("batch"),
    batchId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("case"),
    batchId: z.string().min(1),
    caseKey: z.string().min(1),
  }),
]);

export type EvaluationJobData = z.infer<typeof evaluationJobSchema>;

export function evaluationJobId(data: EvaluationJobData): string {
  return data.kind === "batch" ? `batch:${data.batchId}` : `case:${data.batchId}:${data.caseKey}`;
}

function createEvaluationQueue() {
  const connection = createBullConnection();
  const queue = new Queue<EvaluationJobData>(EVALUATION_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      // One attempt per job at the queue level: retries are decided by the
      // orchestrator, which knows whether a failure was transient.
      attempts: 1,
      removeOnComplete: { count: 1_000 },
      removeOnFail: { count: 5_000 },
    },
  });
  queue.on("error", (error: Error) => {
    logger.warn("evaluation queue error", { message: error.message });
  });
  return { queue, connection };
}

type EvaluationQueue = ReturnType<typeof createEvaluationQueue>["queue"];

let instance: ReturnType<typeof createEvaluationQueue> | null = null;

export function getEvaluationQueue(): EvaluationQueue {
  if (instance === null) {
    instance = createEvaluationQueue();
  }
  return instance.queue;
}

async function enqueue(data: EvaluationJobData): Promise<string> {
  const parsed = evaluationJobSchema.parse(data);
  const job = await getEvaluationQueue().add(parsed.kind === "batch" ? "run-batch" : "run-case", parsed, {
    jobId: evaluationJobId(parsed),
  });
  logger.info("evaluation job enqueued", {
    kind: parsed.kind,
    batchId: parsed.batchId,
    jobId: job.id,
  });
  return job.id ?? evaluationJobId(parsed);
}

export async function enqueueEvaluationBatch(batchId: string): Promise<string> {
  return enqueue({ kind: "batch", batchId });
}

export async function enqueueEvaluationCase(batchId: string, caseKey: string): Promise<string> {
  return enqueue({ kind: "case", batchId, caseKey });
}

export async function closeEvaluationQueue(): Promise<void> {
  if (instance !== null) {
    const { queue, connection } = instance;
    instance = null;
    await queue.close();
    connection.disconnect();
  }
}
