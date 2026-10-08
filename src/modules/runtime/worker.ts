import { Worker } from "bullmq";
import { createBullConnection } from "@/lib/redis/connection";
import { logger } from "@/lib/logging/logger";
import { RUN_QUEUE_NAME, runJobSchema, type RunJobData } from "./queues";

/**
 * Queue worker entry point (BullMQ foundation).
 *
 * Run it alongside the web app:  pnpm worker
 *
 * Phase 0 deliberately stops at the boundary: the processor validates the job
 * payload through the shared schema and acknowledges it. Executing the harness
 * (node-by-node runtime + trace persistence) is Phase 2 — wiring it in means
 * replacing the body of `processRunJob` with a call to the runtime and writing
 * the resulting RunStep/Trace rows.
 */

const workerLogger = logger.child({ module: "runtime.worker" });

export async function processRunJob(data: RunJobData): Promise<{ runId: string; accepted: true }> {
  const job = runJobSchema.parse(data);
  workerLogger.info("run job accepted — execution not implemented in Phase 0", {
    runId: job.runId,
    harnessVersionId: job.harnessVersionId,
  });
  return { runId: job.runId, accepted: true };
}

export function startRunWorker() {
  const worker = new Worker<RunJobData>(RUN_QUEUE_NAME, async (job) => processRunJob(job.data), {
    // BullMQ requires maxRetriesPerRequest: null on worker connections.
    connection: createBullConnection(),
    concurrency: 2,
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
