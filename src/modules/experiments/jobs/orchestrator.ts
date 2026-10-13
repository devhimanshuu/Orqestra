/**
 * Experiment orchestrator.
 *
 * One experiment, one pass, bounded parallelism:
 *
 *   claim → recover interrupted cases → interleave (candidate, case) executions
 *         → settle
 *
 * Everything risky about an experiment lives here, so the rules are stated once:
 *
 *  - **A pass owns the experiment.** `claimForRun` moves QUEUED → RUNNING
 *    atomically. It only ever claims a *queued* experiment, so a redelivered job,
 *    a pass dispatched at a paused experiment, or a second worker either wins the
 *    claim or does nothing — resume is the only path that re-arms a paused run.
 *  - **A case never runs twice.** Each execution goes through the Phase 3 case
 *    runner, whose claim is a conditional PENDING → RUNNING update. This module
 *    decides *when* a case runs; it never decides whether it has already run.
 *  - **Order comes from the sealed schedule.** The assignment rows written at
 *    launch carry `orderIndex`, which encodes the configured ordering
 *    (interleaved / baseline-first / seeded random). The orchestrator therefore
 *    does not re-derive an order — a replay of the same experiment interleaves
 *    identically.
 *  - **Progress is derived, then checkpointed.** Metrics are recomputed from the
 *    case rows every few executions (never from an in-memory counter) and written
 *    down, so a crashed worker leaves an honest, resumable state.
 *  - **Budgets stop scheduling, they do not hide results.** A ceiling on runs,
 *    tokens or estimated cost stops *new* executions; everything already
 *    executed is kept, and the experiment settles as PARTIALLY_COMPLETED with the
 *    reason recorded.
 *  - **Pause stops scheduling; cancel stops everything.** Pause leaves in-flight
 *    cases alone (a case cannot be un-launched mid-node) and resumes by claiming
 *    only the cases that never started. Cancel additionally marks the cases that
 *    never started as cancelled and settles the experiment.
 *  - **Interrupted work is recovered, not ignored.** A RUNNING case whose stale
 *    window has elapsed belongs to a worker that died; it is returned to PENDING
 *    (bounded by the retry policy) or recorded as an interrupted failure —
 *    never silently left to make the experiment unsettleable.
 *
 * Estimated cost is an estimate: it is enforced against *measured* usage, so a
 * single execution can overshoot the ceiling before it is known. The limitation
 * is documented in the configuration snapshot's reproducibility notes and in the
 * service response, never papered over.
 */

import { logger } from "@/lib/logging/logger";
import { evaluationRepository } from "@/modules/evaluation/evaluation.repository";
import { runEvaluationCaseJob } from "@/modules/evaluation/jobs/orchestrator";
import { checkBudget } from "../experiment.objective";
import { experimentRepository } from "../experiment.repository";
import { finalizeExperiment, refreshExperimentMetrics } from "../experiment.service";
import { isTerminalExperimentStatus } from "../experiment.types";
import type {
  ExperimentAssignmentRecord,
  ExperimentCandidateRecord,
  ExperimentRecord,
} from "../experiment.types";
import type { ExperimentRunSummary } from "./types";

const orchestratorLogger = logger.child({ module: "experiments.orchestrator" });

/** Recompute and persist metrics after this many finished executions. */
export const PROGRESS_REFRESH_EVERY = 4;

/** Assumed per-case wall clock when the experiment configures no timeout. */
const ASSUMED_CASE_TIMEOUT_MS = 60_000;
/** Floor on the stale window, so a short timeout cannot mark live work stale. */
const MIN_STALE_WINDOW_MS = 15 * 60_000;

export interface RunExperimentOptions {
  transport: "queue" | "inline" | "unknown";
  /** Identifies the pass in logs; resumes use a fresh nonce. */
  nonce?: string;
}

/** One scheduled execution: which case, for which candidate, in which batch. */
interface PlannedExecution {
  candidateId: string;
  caseKey: string;
  replicate: number;
  batchId: string;
  orderIndex: number;
}

/**
 * How long a RUNNING case may go untouched before it is treated as abandoned.
 *
 * Derived from the case timeout so a legitimately long execution is never
 * mistaken for a crash: three times the configured timeout, with a 15 minute
 * floor for the (common) unconfigured case.
 */
export function staleWindowMs(timeoutMs: number | null): number {
  const base = timeoutMs ?? ASSUMED_CASE_TIMEOUT_MS;
  return Math.max(MIN_STALE_WINDOW_MS, base * 3);
}

/**
 * The pass's execution plan, taken from the sealed assignment rows.
 *
 * Batch ids come from the candidates' replicates (the only records that pair a
 * candidate with its execution vehicle), so an assignment row never has to
 * repeat a batch pointer.
 */
function buildPlan(
  candidates: readonly ExperimentCandidateRecord[],
  assignments: readonly ExperimentAssignmentRecord[],
): PlannedExecution[] {
  const batchByReplicate = new Map<string, string>();
  for (const candidate of candidates) {
    for (const replicate of candidate.replicates) {
      batchByReplicate.set(`${candidate.id}:${replicate.replicate}`, replicate.evaluationBatchId);
    }
  }

  const plan: PlannedExecution[] = [];
  for (const assignment of assignments) {
    const batchId = batchByReplicate.get(`${assignment.candidateId}:${assignment.replicate}`);
    if (batchId === undefined) {
      orchestratorLogger.warn("assignment references a candidate without that replicate", {
        assignmentId: assignment.id,
        candidateId: assignment.candidateId,
        replicate: assignment.replicate,
      });
      continue;
    }
    plan.push({
      candidateId: assignment.candidateId,
      caseKey: assignment.caseKey,
      replicate: assignment.replicate,
      batchId,
      orderIndex: assignment.orderIndex,
    });
  }
  // Ties break on case key so the order is total and reproducible.
  return plan.sort((a, b) => a.orderIndex - b.orderIndex || a.caseKey.localeCompare(b.caseKey));
}

/**
 * How much the experiment has already spent, measured from its case rows.
 *
 * Cost is `null` when any contributing call could not be priced, which is why a
 * cost ceiling is only enforced when the measured total is actually known — an
 * unknown total must not read as zero.
 */
export interface MeasuredSpend {
  started: number;
  tokens: number;
  costUsd: number | null;
}

export function measureSpend(record: {
  metrics: { completed: number; failed: number; cancelled: number; running: number; candidates: Array<{ tokens: { total: number }; cost: { costUsd: number | null } }> } | null;
}): MeasuredSpend {
  const metrics = record.metrics;
  if (metrics === null) {
    return { started: 0, tokens: 0, costUsd: null };
  }
  const tokens = metrics.candidates.reduce((sum, candidate) => sum + candidate.tokens.total, 0);
  const costs = metrics.candidates.map((candidate) => candidate.cost.costUsd);
  return {
    started: metrics.completed + metrics.failed + metrics.cancelled + metrics.running,
    tokens,
    costUsd: costs.some((value) => value === null)
      ? null
      : costs.reduce<number>((sum, value) => sum + (value ?? 0), 0),
  };
}

export interface BudgetDecision {
  stop: boolean;
  reasons: string[];
}

/**
 * Whether the configured budget forbids starting another execution.
 *
 * The rule itself lives in `checkBudget` (the same function the pre-flight uses),
 * so "what the wizard promised" and "what the orchestrator enforces" are the same
 * sentence. `spend` is what the stored metrics already account for and
 * `startedThisPass` is what this pass began since those metrics were read — both
 * are needed because metrics are checkpointed, not recomputed per case.
 */
export function evaluateBudget(input: {
  budget: ExperimentRecord["execution"]["budget"];
  spend: MeasuredSpend;
  startedThisPass: number;
}): BudgetDecision {
  const verdict = checkBudget({
    budget: input.budget,
    usage: {
      executionsStarted: input.spend.started + input.startedThisPass,
      totalTokens: input.spend.tokens,
      costUsd: input.spend.costUsd,
    },
  });
  return verdict.allowed || verdict.message === null
    ? { stop: false, reasons: [] }
    : { stop: true, reasons: [verdict.message] };
}

/**
 * Runs one whole experiment. Safe to invoke twice: the second caller fails to
 * claim the experiment and returns without touching a single case.
 */
export async function runExperimentJob(
  experimentId: string,
  options: RunExperimentOptions,
): Promise<ExperimentRunSummary> {
  const empty: ExperimentRunSummary = {
    experimentId,
    claimed: false,
    scheduled: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    recovered: 0,
    budgetStop: false,
    paused: false,
  };

  const record = await experimentRepository.findById(experimentId);
  if (record === null) {
    return empty;
  }
  if (isTerminalExperimentStatus(record.status)) {
    orchestratorLogger.info("experiment is already settled — nothing to do", {
      experimentId,
      status: record.status,
    });
    return { ...empty, status: record.status };
  }

  const claimed = await experimentRepository.claimForRun(experimentId);
  if (!claimed) {
    orchestratorLogger.info("experiment is not claimable — skipping this pass", {
      experimentId,
      status: record.status,
      cancelRequested: record.cancelRequestedAt !== null,
    });
    return empty;
  }

  const candidates = await experimentRepository.listCandidates(experimentId);
  const batchIds = candidates.flatMap((candidate) =>
    candidate.replicates.map((replicate) => replicate.evaluationBatchId),
  );

  // --- recovery: work abandoned by a previous (dead) pass ---------------------
  const recovered = await recoverInterruptedCases(record, batchIds);

  // --- cancellation observed before any new work -----------------------------
  if (record.cancelRequestedAt !== null) {
    await evaluationRepository.cancelPendingCases(batchIds, {
      kind: "cancelled",
      code: "EXPERIMENT_CANCELLED",
      message: "Cancelled before this case started.",
    });
    const settled = await finalizeExperiment(experimentId, { budgetStop: false });
    orchestratorLogger.info("experiment cancelled before execution", { experimentId });
    return { ...empty, claimed: true, status: settled?.status, recovered };
  }

  const assignments = await experimentRepository.listAssignments(experimentId);
  const plan = buildPlan(candidates, assignments);
  const terminal = await terminalCaseKeys(batchIds);

  const summary: ExperimentRunSummary = {
    ...empty,
    claimed: true,
    scheduled: plan.length,
  };

  // Metrics checkpoint: the spend figures budget enforcement reads.
  let spend = measureSpend(record);
  let startedThisPass = 0;
  let sinceRefresh = 0;
  let budgetStop = false;
  let paused = false;
  let cancelRequested = false;
  const stopReasons: string[] = [];

  const budget = record.execution.budget;
  const concurrency = Math.max(1, Math.min(record.execution.concurrency, 5));
  const maxAttempts = Math.max(1, Math.min(record.execution.retryPolicy.maxAttempts, 5));

  /** Re-reads the durable flags; the orchestrator never guesses at intent. */
  const control = async (): Promise<"stop" | "pause" | "cancel" | "continue"> => {
    const current = await experimentRepository.findById(experimentId);
    if (current === null) {
      return "stop";
    }
    if (current.cancelRequestedAt !== null) {
      return "cancel";
    }
    if (current.pausedAt !== null) {
      return "pause";
    }
    const decision = evaluateBudget({ budget, spend, startedThisPass });
    if (decision.stop) {
      for (const reason of decision.reasons) {
        if (!stopReasons.includes(reason)) {
          stopReasons.push(reason);
        }
      }
      return "stop";
    }
    return "continue";
  };

  const checkpoint = async (force: boolean): Promise<void> => {
    sinceRefresh += 1;
    if (!force && sinceRefresh < PROGRESS_REFRESH_EVERY) {
      return;
    }
    sinceRefresh = 0;
    const refreshed = await refreshExperimentMetrics(experimentId);
    if (refreshed !== null) {
      spend = measureSpend(refreshed);
    }
  };

  /** Executes one case (with the experiment's retry policy) and records it. */
  const runOne = async (execution: PlannedExecution): Promise<void> => {
    startedThisPass += 1;
    const key = `${execution.batchId}:${execution.caseKey}`;
    if (terminal.has(key)) {
      summary.skipped += 1;
      return;
    }

    const outcome = await runEvaluationCaseJob(execution.batchId, execution.caseKey, {
      maxAttempts,
    });
    if (outcome.status === "completed") {
      summary.completed += 1;
    } else if (outcome.status === "failed") {
      summary.failed += 1;
      // A failed case is evidence, not an abort: the remaining cases still run.
      const row = await evaluationRepository.findCase(execution.batchId, execution.caseKey);
      orchestratorLogger.warn("experiment case failed", {
        experimentId,
        caseKey: execution.caseKey,
        candidateId: execution.candidateId,
        replicate: execution.replicate,
        attempts: row?.attempts ?? null,
      });
    } else if (outcome.status === "cancelled") {
      summary.cancelled += 1;
    } else {
      summary.skipped += 1;
    }
  };

  if (concurrency === 1) {
    for (const execution of plan) {
      const decision = await control();
      if (decision === "cancel") {
        cancelRequested = true;
        break;
      }
      if (decision === "pause") {
        paused = true;
        break;
      }
      if (decision === "stop") {
        budgetStop = true;
        break;
      }
      await runOne(execution);
      await checkpoint(false);
    }
  } else {
    let cursor = 0;
    let halt = false;
    const workers = Array.from({ length: Math.min(concurrency, plan.length) }, async () => {
      while (!halt) {
        const index = cursor;
        cursor += 1;
        if (index >= plan.length) {
          return;
        }
        const decision = await control();
        if (decision !== "continue") {
          halt = true;
          if (decision === "cancel") {
            cancelRequested = true;
          } else if (decision === "pause") {
            paused = true;
          } else {
            budgetStop = true;
          }
          return;
        }
        const execution = plan[index];
        if (execution === undefined) {
          continue;
        }
        await runOne(execution);
        await checkpoint(false);
      }
    });
    await Promise.all(workers);
  }

  // A cancellation observed mid-pass: the cases that never started are recorded
  // as cancelled so the experiment settles without phantom PENDING rows.
  let cancelledCases = 0;
  if (cancelRequested) {
    cancelledCases = await evaluationRepository.cancelPendingCases(batchIds, {
      kind: "cancelled",
      code: "EXPERIMENT_CANCELLED",
      message: "Cancelled before this case started.",
    });
  }

  if (budgetStop) {
    for (const reason of stopReasons) {
      orchestratorLogger.warn("experiment stopped early by a budget", {
        experimentId,
        reason,
      });
    }
  }

  let settled: ExperimentRecord | null = null;
  if (!paused) {
    await checkpoint(true);
    settled = await finalizeExperiment(experimentId, { budgetStop });
  } else {
    // Paused: persist honest progress, but never settle — the experiment is
    // deliberately unfinished, so its status stays PAUSED.
    await refreshExperimentMetrics(experimentId);
  }

  orchestratorLogger.info("experiment pass finished", {
    experimentId,
    transport: options.transport,
    nonce: options.nonce ?? null,
    concurrency,
    planned: plan.length,
    completed: summary.completed,
    failed: summary.failed,
    cancelled: summary.cancelled,
    skipped: summary.skipped,
    recovered,
    paused,
    budgetStop,
    cancelledCases,
    status: settled?.status,
  });

  return {
    ...summary,
    paused,
    budgetStop,
    ...(settled !== null ? { status: settled.status } : {}),
  };
}

/** Case keys (batch-qualified) that already reached a terminal status. */
async function terminalCaseKeys(batchIds: readonly string[]): Promise<Set<string>> {
  const statuses = await experimentRepository.listCaseStatuses(batchIds);
  const keys = new Set<string>();
  for (const entry of statuses) {
    if (entry.status === "PENDING" || entry.status === "RUNNING") {
      continue;
    }
    keys.add(`${entry.evaluationBatchId}:${entry.caseKey}`);
  }
  return keys;
}

/**
 * Returns cases left RUNNING by a worker that died to PENDING, or records them
 * as an interrupted failure when their attempt budget is used up.
 *
 * The stale window is the safety valve: a case that is genuinely in flight is
 * never touched, because nothing resets a RUNNING row before the window closes.
 * Returns the number of cases recovered (reset or failed-as-interrupted).
 */
export async function recoverInterruptedCases(
  record: ExperimentRecord,
  batchIds: readonly string[],
): Promise<number> {
  const running = await experimentRepository.listRunningCases(batchIds);
  if (running.length === 0) {
    return 0;
  }
  const window = staleWindowMs(record.execution.timeoutMs);
  const now = Date.now();
  const maxAttempts = Math.max(1, Math.min(record.execution.retryPolicy.maxAttempts, 5));
  let recovered = 0;

  for (const entry of running) {
    const claimedAt = entry.startedAt?.getTime() ?? null;
    const age = claimedAt === null ? Number.POSITIVE_INFINITY : now - claimedAt;
    if (age < window) {
      continue;
    }

    if (entry.attempts < maxAttempts) {
      const reset = await evaluationRepository.resetInterruptedCase(
        entry.evaluationBatchId,
        entry.caseKey,
      );
      if (reset) {
        recovered += 1;
        orchestratorLogger.warn("recovering an interrupted case", {
          experimentId: record.id,
          batchId: entry.evaluationBatchId,
          caseKey: entry.caseKey,
          attempts: entry.attempts,
          staleMs: age,
        });
      }
      continue;
    }

    // Out of attempts: record the interruption as a failure so the experiment can
    // settle. It counts as a *failed execution*, never as a zero score, and it is
    // labelled with its own code so nobody mistakes it for a quality regression.
    await evaluationRepository.completeCase(entry.evaluationBatchId, entry.id, {
      status: "FAILED",
      error: {
        kind: "internal",
        code: "CASE_INTERRUPTED",
        message: `The execution was interrupted and did not finish within ${Math.round(window / 1000)}s; the retry budget of ${maxAttempts} attempt(s) was exhausted.`,
      },
      incrementCompleted: false,
      incrementFailed: true,
    });
    recovered += 1;
    orchestratorLogger.warn("interrupted case recorded as failed (retry budget exhausted)", {
      experimentId: record.id,
      batchId: entry.evaluationBatchId,
      caseKey: entry.caseKey,
      attempts: entry.attempts,
    });
  }

  return recovered;
}
