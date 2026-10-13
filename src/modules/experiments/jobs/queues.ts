import { Queue } from "bullmq";
import { z } from "zod";
import { createBullConnection } from "@/lib/redis/connection";
import { logger } from "@/lib/logging/logger";

/**
 * Experiment queue.
 *
 * One job kind, deliberately: a whole experiment is a single long-lived
 * orchestration that runs each case through the *evaluation* case runner. Case
 * granularity already exists one layer down (`runEvaluationCaseJob`), so splitting
 * cases into separate queue jobs here would duplicate that mechanism and make the
 * interleaving order impossible to honour.
 *
 * Job ids include a nonce, which is what makes resume work: BullMQ dedupes by id
 * while a job exists, so re-arming a paused experiment must be a *distinct* job.
 * Idempotency does not depend on the id — a case is claimed with a conditional
 * update (PENDING → RUNNING), so two passes (or a redelivered job) can never
 * execute the same case twice.
 */

export const EXPERIMENT_QUEUE_NAME = "orqestra.experiments";

export const experimentJobSchema = z.object({
  kind: z.literal("experiment"),
  experimentId: z.string().min(1),
  /** `initial` for the launch; a timestamp-ish token for each resume. */
  nonce: z.string().min(1).default("initial"),
});

export type ExperimentJobData = z.infer<typeof experimentJobSchema>;

export function experimentJobId(data: ExperimentJobData): string {
  return `experiment:${data.experimentId}:${data.nonce}`;
}

function createExperimentQueue() {
  const connection = createBullConnection();
  const queue = new Queue<ExperimentJobData>(EXPERIMENT_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      // One attempt per job at the queue level: the orchestrator owns retries
      // (it knows whether a case failure was transient) and always reconciles.
      attempts: 1,
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 2_000 },
    },
  });
  queue.on("error", (error: Error) => {
    logger.warn("experiment queue error", { message: error.message });
  });
  return { queue, connection };
}

type ExperimentQueue = ReturnType<typeof createExperimentQueue>["queue"];

let instance: ReturnType<typeof createExperimentQueue> | null = null;

export function getExperimentQueue(): ExperimentQueue {
  if (instance === null) {
    instance = createExperimentQueue();
  }
  return instance.queue;
}

export async function enqueueExperiment(experimentId: string, nonce = "initial"): Promise<string> {
  const parsed = experimentJobSchema.parse({ kind: "experiment", experimentId, nonce });
  const job = await getExperimentQueue().add("run-experiment", parsed, {
    jobId: experimentJobId(parsed),
  });
  logger.info("experiment job enqueued", {
    experimentId,
    nonce,
    jobId: job.id ?? experimentJobId(parsed),
  });
  return job.id ?? experimentJobId(parsed);
}

export async function closeExperimentQueue(): Promise<void> {
  if (instance !== null) {
    const { queue, connection } = instance;
    instance = null;
    await queue.close();
    connection.disconnect();
  }
}
