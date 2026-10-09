import { Worker } from "bullmq";
import { createBullConnection } from "@/lib/redis/connection";
import { logger } from "@/lib/logging/logger";
import { RUN_QUEUE_NAME, runJobSchema, type RunJobData } from "./queues";
import { executeRun } from "./run.executor";

/**
 * Queue worker entry point.
 *
 * Run it alongside the web app:  pnpm worker
 *
 * The processor is a thin adapter: validate the job payload, then hand off to
 * `executeRun`, which owns loading, compiling, executing and persisting the run.
 * Everything long-running happens here, never in an HTTP request.
 *
 * Delivery semantics: a BullMQ job runs at most once per attempt, and
 * `executeRun` claims the run row atomically (QUEUED → RUNNING), so a duplicated
 * job (or a crash-and-redeliver) cannot execute a run twice.
 */

const workerLogger = logger.child({ module: "runtime.worker" });

export async function processRunJob(data: RunJobData): Promise<{ runId: string; accepted: true }> {
  const job = runJobSchema.parse(data);
  workerLogger.info("run job picked up", {
    runId: job.runId,
    harnessVersionId: job.harnessVersionId,
  });

  const result = await executeRun(job.runId, { transport: "queue" });
  workerLogger.info("run job finished", {
    runId: job.runId,
    status: result.status,
    skipped: result.skipped,
  });
  return { runId: job.runId, accepted: true };
}

export function startRunWorker() {
  const worker = new Worker<RunJobData>(RUN_QUEUE_NAME, async (job) => processRunJob(job.data), {
    // BullMQ requires maxRetriesPerRequest: null on worker connections.
    connection: createBullConnection(),
    concurrency: 2,
    // A run can legitimately take minutes; BullMQ's default lock duration is
    // shorter than that, so renew the lock instead of letting a long run be
    // redelivered to another worker.
    lockDuration: 120_000,
    stalledInterval: 60_000,
  });

  worker.on("ready", () => workerLogger.info("run worker ready", { queue: RUN_QUEUE_NAME }));
  worker.on("failed", (job, error) => {
    workerLogger.error("run job failed", { jobId: job?.id, message: error.message });
  });
  worker.on("error", (error) => {
    workerLogger.warn("run worker error", { message: error.message });
  });

  return worker;
}

/**
 * Standalone processes launched via tsx do not get Next.js' automatic `.env`
 * loading, so load it here — but never override variables that are already set
 * (real environment wins, which is what deployments rely on).
 */
function loadLocalEnv(): void {
  if (process.env.DATABASE_URL !== undefined) {
    return;
  }
  try {
    process.loadEnvFile();
  } catch {
    // No .env file — env validation reports exactly what is missing.
  }
}

/** Script entry when executed with `tsx src/modules/runtime/worker.ts`. */
async function main(): Promise<void> {
  loadLocalEnv();
  const { getEnv } = await import("@/config/env");
  const { getPrisma } = await import("@/lib/db/prisma");
  const { getToolRegistry } = await import("@/modules/tools");

  const env = getEnv();
  getPrisma();
  // Warm the tool registry so the first run does not pay for registration.
  getToolRegistry();
  workerLogger.info("worker starting", {
    executionMode: env.RUN_EXECUTION_MODE,
    queue: RUN_QUEUE_NAME,
  });

  const worker = startRunWorker();

  const shutdown = async (signal: string): Promise<void> => {
    workerLogger.info("worker shutting down", { signal });
    await worker.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (process.argv[1] !== undefined && /worker\.(ts|js|mts|mjs)$/.test(process.argv[1])) {
  main().catch((error: unknown) => {
    workerLogger.error("worker crashed", {
      message: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
}
