import { Queue } from "bullmq";
import { z } from "zod";
import { createBullConnection } from "@/lib/redis/connection";
import { logger } from "@/lib/logging/logger";

/**
 * Optimization queue.
 *
 * One job per *pass* over a session: the job analyzes, proposes, mutates,
 * validates, evaluates and decides, then either settles the session or parks it
 * awaiting review. The pass is idempotent — it claims the session atomically and
 * every row it writes is keyed by a fingerprint or a conditional update — so a
 * redelivered job cannot evaluate the same candidate twice.
 *
 * Resumes get a fresh nonce, which becomes a new job id: a session may legitimately
 * be run again (after approval, or after a crash) without colliding with the
 * original job's history.
 *
 * The queue mirrors the run and evaluation dispatchers: `enqueue` is the public,
 * transport-neutral entrypoint, and the worker keeps one consumer per pass.
 */

export const OPTIMIZATION_QUEUE_NAME = "orqestra.optimization";

export const optimizationJobSchema = z.object({
  kind: z.literal("optimization"),
  sessionId: z.string().min(1),
  nonce: z.string().min(1),
});

export type OptimizationJobData = z.infer<typeof optimizationJobSchema>;

export function optimizationJobId(data: OptimizationJobData): string {
  return `optimization:${data.sessionId}:${data.nonce}`;
}

function createOptimizationQueue() {
  const connection = createBullConnection();
  const queue = new Queue<OptimizationJobData>(OPTIMIZATION_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 1_000 },
      removeOnFail: { count: 5_000 },
    },
  });
  queue.on("error", (error: Error) => {
    logger.warn("optimization queue error", { message: error.message });
  });
  return { queue, connection };
}

type OptimizationQueue = ReturnType<typeof createOptimizationQueue>["queue"];

let instance: ReturnType<typeof createOptimizationQueue> | null = null;

export function getOptimizationQueue(): OptimizationQueue {
  if (instance === null) {
    instance = createOptimizationQueue();
  }
  return instance.queue;
}

export async function enqueueOptimization(sessionId: string, nonce = "initial"): Promise<string> {
  const parsed = optimizationJobSchema.parse({ kind: "optimization", sessionId, nonce });
  const job = await getOptimizationQueue().add("run-optimization", parsed, {
    jobId: optimizationJobId(parsed),
  });
  logger.info("optimization job enqueued", { sessionId, jobId: job.id, nonce });
  return job.id ?? optimizationJobId(parsed);
}

export async function closeOptimizationQueue(): Promise<void> {
  if (instance !== null) {
    const { queue, connection } = instance;
    instance = null;
    await queue.close();
    connection.disconnect();
  }
}
