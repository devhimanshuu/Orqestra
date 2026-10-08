import { Queue } from "bullmq";
import { z } from "zod";
import { createBullConnection } from "@/lib/redis/connection";
import { logger } from "@/lib/logging/logger";

/**
 * Queue layer (BullMQ foundation).
 *
 * Long-running agent work never runs inside an HTTP request: route handlers
 * and services only enqueue jobs. The Phase 2 runtime consumes them via
 * src/modules/runtime/worker.ts.
 */

export const RUN_QUEUE_NAME = "orqestra.runs";

/** Job payload contract — validated on both sides of the queue. */
export const runJobSchema = z.object({
  runId: z.string().min(1),
  harnessVersionId: z.string().min(1),
});

export type RunJobData = z.infer<typeof runJobSchema>;

/**
 * BullMQ owns its connections: it needs `maxRetriesPerRequest: null` and
 * blocking-capable sockets, so it never shares the app's command client.
 */
function createRunQueue() {
  const connection = createBullConnection();
  const queue = new Queue<RunJobData>(RUN_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 1_000 },
      removeOnFail: { count: 5_000 },
    },
  });
  queue.on("error", (error: Error) => {
    logger.warn("run queue error", { message: error.message });
  });
  return { queue, connection };
}

type RunQueue = ReturnType<typeof createRunQueue>["queue"];

let instance: ReturnType<typeof createRunQueue> | null = null;

export function getRunQueue(): RunQueue {
  if (instance === null) {
    instance = createRunQueue();
  }
  return instance.queue;
}

/** Enqueues a run for asynchronous execution. Returns the BullMQ job id. */
export async function enqueueRun(data: RunJobData): Promise<string> {
  const parsed = runJobSchema.parse(data);
  // The BullMQ job id is the run id: enqueueing is idempotent per run.
  const job = await getRunQueue().add("execute-run", parsed, { jobId: parsed.runId });
  logger.info("run enqueued", { runId: parsed.runId, jobId: job.id });
  return job.id ?? parsed.runId;
}

export async function closeRunQueue(): Promise<void> {
  if (instance !== null) {
    const { queue, connection } = instance;
    instance = null;
    await queue.close();
    connection.disconnect();
  }
}
