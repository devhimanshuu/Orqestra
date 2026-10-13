/**
 * Evaluation orchestrator.
 *
 * One batch, many cases, bounded parallelism:
 *
 *   claim batch → for each case (concurrency N): claim → run + evaluate → persist
 *                → settle the batch (status + metrics)
 *
 * Reliability rules, all of them deliberate:
 *
 *  - **Claims are atomic.** The batch moves PENDING → RUNNING, and each case
 *    PENDING → RUNNING, through conditional updates. A redelivered job therefore
 *    does nothing rather than running a case twice.
 *  - **A failing case is contained.** Its failure is persisted with a structured
 *    error and the loop continues; only cases that fail deterministically are
 *    left failed, while transient failures (provider hiccups, worker crashes)
 *    are retried up to `MAX_CASE_ATTEMPTS`.
 *  - **Results are idempotent.** Verdicts are upserted on
 *    (caseResultId, evaluatorKey), so a retry overwrites instead of appending.
 *  - **Cancellation is observed, not simulated.** The durable flag is checked
 *    between cases and inside each case (the run itself is cancelled through the
 *    runtime's own cancellation channel).
 *  - **Progress is derived from rows,** never from a counter the orchestrator
 *    keeps in memory — a crashed worker leaves an honest state.
 */

import { logger } from "@/lib/logging/logger";
import { evaluationRepository } from "../evaluation.repository";
import { finalizeBatch } from "../evaluation.service";
import { executeEvaluationCase } from "../case.runner";
import type { BatchRunSummary } from "./types";

const orchestratorLogger = logger.child({ module: "evaluation.orchestrator" });

/** Attempts per case, including the first. Deterministic failures use one. */
export const MAX_CASE_ATTEMPTS = 2;

/**
 * Hard ceiling on attempts, whatever a caller asks for. A caller may lower the
 * retry count (a cheap evaluation, an experiment with its own policy) but never
 * raise it past this — retry storms are a platform-level constraint, not a
 * per-request preference.
 */
export const MAX_CASE_ATTEMPTS_CEILING = 5;

export interface RunBatchOptions {
  transport: "queue" | "inline" | "unknown";
  /** Restrict this pass to one case (explicit "retry this case" action). */
  onlyCaseKey?: string;
}

export interface RunCaseOptions {
  /**
   * Attempts per case, including the first. Clamped to
   * `[1, MAX_CASE_ATTEMPTS_CEILING]`. Defaults to `MAX_CASE_ATTEMPTS`.
   */
  maxAttempts?: number;
}

async function isCancellationRequested(batchId: string): Promise<boolean> {
  const batch = await evaluationRepository.findById(batchId);
  return batch?.cancelRequestedAt !== null;
}

/**
 * Processes exactly one case: claim, execute, retry if the failure was
 * transient, persist the verdicts and settle the case row.
 */
export async function runEvaluationCaseJob(
  batchId: string,
  caseKey: string,
  options: RunCaseOptions = {},
): Promise<{ status: "completed" | "failed" | "cancelled" | "skipped" }> {
  const maxAttempts = Math.min(
    Math.max(1, options.maxAttempts ?? MAX_CASE_ATTEMPTS),
    MAX_CASE_ATTEMPTS_CEILING,
  );
  const batch = await evaluationRepository.findById(batchId);
  if (batch === null) {
    return { status: "skipped" };
  }
  const sample = batch.datasetSnapshot.find((entry) => entry.caseKey === caseKey);
  if (sample === undefined) {
    orchestratorLogger.warn("case job references an unknown dataset case", { batchId, caseKey });
    return { status: "skipped" };
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const claimed = await evaluationRepository.claimCase(batchId, caseKey);
    if (claimed === null) {
      // Already claimed by another worker, or already terminal.
      return { status: "skipped" };
    }

    const result = await executeEvaluationCase({
      batch,
      case: claimed,
      sample,
      logger: orchestratorLogger,
      shouldCancel: () => isCancellationRequested(batchId),
    });

    if (result.runId !== null) {
      await evaluationRepository.attachRun(claimed.id, result.runId);
    }

    if (result.ok) {
      await evaluationRepository.saveResults(
        result.results.map((record) => ({
          batchId,
          caseResultId: claimed.id,
          runId: result.runId,
          result: record,
        })),
      );
      await evaluationRepository.completeCase(batchId, claimed.id, {
        status: "COMPLETED",
        runId: result.runId,
        aggregateScore: result.aggregate.score,
        aggregateStatus: result.aggregate.status,
        error: null,
        incrementCompleted: true,
        incrementFailed: false,
      });
      return { status: "completed" };
    }

    // Persist whatever verdicts did arrive (an evaluator may have failed while
    // others scored) before deciding the case's fate.
    if (result.results.length > 0) {
      await evaluationRepository.saveResults(
        result.results.map((record) => ({
          batchId,
          caseResultId: claimed.id,
          runId: result.runId,
          result: record,
        })),
      );
    }

    if (result.error.kind === "cancelled") {
      await evaluationRepository.completeCase(batchId, claimed.id, {
        status: "CANCELLED",
        runId: result.runId,
        error: result.error,
        incrementCompleted: false,
        incrementFailed: false,
      });
      return { status: "cancelled" };
    }

    const canRetry = result.error.retryable && attempt < maxAttempts - 1;
    if (canRetry) {
      orchestratorLogger.warn("retrying evaluation case after a transient failure", {
        batchId,
        caseKey,
        attempt: attempt + 1,
        code: result.error.code,
      });
      await evaluationRepository.resetCaseForRetry(batchId, caseKey);
      continue;
    }

    await evaluationRepository.completeCase(batchId, claimed.id, {
      status: "FAILED",
      runId: result.runId,
      aggregateScore: result.aggregate?.score ?? null,
      aggregateStatus: result.aggregate?.status ?? null,
      error: result.error,
      incrementCompleted: false,
      incrementFailed: true,
    });
    return { status: "failed" };
  }

  return { status: "failed" };
}

/**
 * Runs a whole batch. Safe to invoke twice: the second caller finds the batch
 * already claimed and returns without work.
 */
export async function runEvaluationBatch(
  batchId: string,
  options: RunBatchOptions,
): Promise<BatchRunSummary> {
  const batch = await evaluationRepository.findById(batchId);
  if (batch === null) {
    return { batchId, claimed: false, completed: 0, failed: 0, cancelled: 0, skipped: 0 };
  }

  const claimed = await claimBatch(batchId);
  if (!claimed) {
    // A single-case retry must not need the batch claim (the batch is already
    // terminal in that flow), so it proceeds without it.
    if (options.onlyCaseKey === undefined) {
      orchestratorLogger.info("evaluation batch already claimed — skipping", {
        batchId,
        status: batch.status,
      });
      return { batchId, claimed: false, completed: 0, failed: 0, cancelled: 0, skipped: batch.caseCount };
    }
  }

  const cases =
    options.onlyCaseKey === undefined
      ? (await evaluationRepository.listCases(batchId, { limit: 1_000 })).cases
      : (await evaluationRepository.listCases(batchId, { limit: 1_000 })).cases.filter(
          (row) => row.caseKey === options.onlyCaseKey,
        );

  const concurrency = Math.max(1, batch.config.concurrency);
  const summary: BatchRunSummary = {
    batchId,
    claimed,
    completed: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
  };

  if (concurrency === 1) {
    for (const row of cases) {
      if (await isCancellationRequested(batchId)) {
        const outcome = await cancelPendingCase(batchId, row.caseKey);
        summary[outcome] += 1;
        continue;
      }
      const { status } = await runEvaluationCaseJob(batchId, row.caseKey);
      summary[status] += 1;
    }
  } else {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, cases.length) }, async () => {
      while (cursor < cases.length) {
        const index = cursor;
        cursor += 1;
        const row = cases[index];
        if (row === undefined) {
          continue;
        }
        if (await isCancellationRequested(batchId)) {
          const outcome = await cancelPendingCase(batchId, row.caseKey);
          summary[outcome] += 1;
          continue;
        }
        const { status } = await runEvaluationCaseJob(batchId, row.caseKey);
        summary[status] += 1;
      }
    });
    await Promise.all(workers);
  }

  // Settle: status + metrics, computed from the rows themselves.
  const settled = await finalizeBatch(batchId);
  if (settled !== null) {
    summary.status = settled.status;
  }

  orchestratorLogger.info("evaluation batch finished", {
    batchId,
    transport: options.transport,
    completed: summary.completed,
    failed: summary.failed,
    cancelled: summary.cancelled,
    skipped: summary.skipped,
    status: summary.status,
  });
  return summary;
}

/** Atomically claims a PENDING batch for this orchestrator. */
async function claimBatch(batchId: string): Promise<boolean> {
  const { getPrisma } = await import("@/lib/db/prisma");
  const result = await getPrisma().evaluationBatch.updateMany({
    where: { id: batchId, status: "PENDING" },
    data: { status: "RUNNING", startedAt: new Date() },
  });
  return result.count > 0;
}

/** Marks a not-yet-started case as cancelled. */
async function cancelPendingCase(
  batchId: string,
  caseKey: string,
): Promise<"cancelled" | "skipped"> {
  const row = await evaluationRepository.findCase(batchId, caseKey);
  if (row === null || row.status !== "PENDING") {
    return "skipped";
  }
  await evaluationRepository.completeCase(batchId, row.id, {
    status: "CANCELLED",
    error: {
      kind: "cancelled",
      code: "BATCH_CANCELLED",
      message: "Cancelled before this case started.",
    },
    incrementCompleted: false,
    incrementFailed: false,
  });
  return "cancelled";
}
