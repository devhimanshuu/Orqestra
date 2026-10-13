/**
 * Candidate and experiment metrics.
 *
 * The heavy lifting already exists: `computeBatchMetrics` derives every number
 * from persisted case rows. What this module adds is aggregation *across* a
 * candidate's replicate batches (the same case executed more than once) and the
 * per-case observations that comparison and regression analysis align on.
 *
 * Rules that are deliberately kept from Phase 3, because they are what makes an
 * experiment honest:
 *
 *  - a rate over zero items is `null` (not 0, not 1);
 *  - a failed execution is not a zero score — it is excluded from the score
 *    aggregates and counted, separately, as a failure;
 *  - tokens report how many executions actually reported usage;
 *  - cost is an estimate carrying its source and its unpriced models;
 *  - latency aggregates skip executions that never started;
 *  - with replicates, a case's value is the mean of its scored trials, and the
 *    case counts as *passed* only when every scored trial passed (strict, so a
 *    flaky candidate cannot look better than a stable one).
 */

import {
  average,
  computeBatchMetrics,
  median,
  percentile,
  type BatchMetrics,
  type BatchCaseMetricRow,
  type EvaluatorMetric,
  type EvaluatorUsage,
} from "@/modules/evaluation/metrics";
import type { CostEstimate, PricedUsage } from "@/modules/evaluation/pricing";
import type { AggregateStatus, EvaluationResultRecord } from "@/modules/evaluation/evaluation.types";
import type { CaseStatus } from "@/modules/evaluation/batch.types";
import type { RunStatus } from "@/modules/runtime/run.types";
import type { DatasetCaseSnapshot } from "@/modules/evaluation/dataset.types";
import type { ExperimentCandidateRole, ExperimentCaseObservation } from "./experiment.types";

/** One case execution of one candidate: the row shape the repository returns. */
export interface CandidateCaseMetricRow {
  caseKey: string;
  index: number;
  /** Which replicate this execution belongs to (1-based). */
  replicate: number;
  evaluationBatchId: string;
  caseResultId: string | null;
  status: CaseStatus;
  runId: string | null;
  /** Execution status of the run that produced this case (null when none ran). */
  runStatus: RunStatus | null;
  aggregateScore: number | null;
  aggregateStatus: AggregateStatus | null;
  passed: boolean | null;
  latencyMs: number | null;
  totalTokens: number | null;
  attempt: number;
  toolCalls: number;
  /** Number of node executions in the run (0 when it never ran). */
  stepCount: number;
  usage: PricedUsage[];
  error: Record<string, unknown> | null;
  results: EvaluationResultRecord[];
}

/** Everything the UI, the ranking engine and the export need about one candidate. */
export interface CandidateMetrics {
  candidateId: string;
  label: string;
  role: ExperimentCandidateRole;
  harnessVersionId: string;
  harnessVersion: number;
  /** Distinct dataset cases this candidate executed. */
  caseCount: number;
  /** Case executions across all replicates. */
  executions: number;
  plannedExecutions: number;
  completed: number;
  failed: number;
  skipped: number;
  cancelled: number;
  pending: number;
  running: number;
  /** Executions that produced an aggregate score. */
  scored: number;
  unscored: number;
  /** Executions whose aggregate is INCOMPLETE (some evaluator produced nothing). */
  incomplete: number;
  score: { mean: number | null; median: number | null };
  passRate: number | null;
  failureRate: number | null;
  passed: number;
  failedVerdicts: number;
  latency: { averageMs: number | null; medianMs: number | null; p95Ms: number | null; measured: number };
  tokens: { total: number; reported: number; unreported: number };
  cost: CostEstimate & { billedNote: "estimated" };
  retries: number;
  toolInvocations: number;
  toolCallsPerCase: number | null;
  /** Timed-out executions / terminal executions. */
  timeoutRate: number | null;
  timedOut: number;
  /** Evaluator verdicts that errored (a scoring infrastructure failure). */
  evaluatorErrors: number;
  perEvaluator: EvaluatorMetric[];
  evaluatorUsage: EvaluatorUsage;
  /** The underlying Phase 3 aggregates, kept so nothing is recomputed differently. */
  batchMetrics: BatchMetrics;
  /** Survey of what went wrong, for the reliability panel. */
  errorCategories: Record<string, number>;
}

export interface ExperimentMetrics {
  computedAt: string;
  /** Executions planned by the configuration at launch. */
  plannedExecutions: number;
  /** Assignment rows that exist (equals plannedExecutions for a sealed experiment). */
  executions: number;
  completed: number;
  failed: number;
  skipped: number;
  cancelled: number;
  running: number;
  pending: number;
  /** True when no execution is still outstanding. */
  complete: boolean;
  /** Distinct dataset cases (one per aligned case). */
  caseCount: number;
  candidates: CandidateMetrics[];
}

/** Projects our richer row onto the Phase 3 metric row, then reuses its engine. */
function toBatchRow(row: CandidateCaseMetricRow): BatchCaseMetricRow {
  return {
    status: row.status,
    aggregateScore: row.aggregateScore,
    aggregateStatus: row.aggregateStatus,
    passed: row.passed,
    latencyMs: row.latencyMs,
    totalTokens: row.totalTokens,
    attempt: row.attempt,
    toolCalls: row.toolCalls,
    usage: row.usage,
    results: row.results,
  };
}

function countErrorCategories(rows: readonly CandidateCaseMetricRow[]): Record<string, number> {
  const categories: Record<string, number> = {};
  for (const row of rows) {
    if (row.status === "FAILED") {
      categories["case_failed"] = (categories["case_failed"] ?? 0) + 1;
    }
    if (row.status === "CANCELLED") {
      categories["case_cancelled"] = (categories["case_cancelled"] ?? 0) + 1;
    }
    if (row.runStatus === "TIMED_OUT") {
      categories["run_timed_out"] = (categories["run_timed_out"] ?? 0) + 1;
    }
    if (row.runStatus === "FAILED") {
      categories["run_failed"] = (categories["run_failed"] ?? 0) + 1;
    }
    for (const result of row.results) {
      if (result.status === "ERROR") {
        const key = `evaluator_error:${result.kind}`;
        categories[key] = (categories[key] ?? 0) + 1;
      }
    }
  }
  return categories;
}

export interface CandidateMetricsInput {
  candidateId: string;
  label: string;
  role: ExperimentCandidateRole;
  harnessVersionId: string;
  harnessVersion: number;
  policy: BatchMetrics["policy"];
  plannedExecutions: number;
  rows: readonly CandidateCaseMetricRow[];
}

export function computeCandidateMetrics(input: CandidateMetricsInput): CandidateMetrics {
  const batchMetrics = computeBatchMetrics({
    policy: input.policy,
    cases: input.rows.map(toBatchRow),
  });

  const terminal = input.rows.filter(
    (row) => row.runStatus === "SUCCEEDED" || row.runStatus === "FAILED" || row.runStatus === "TIMED_OUT" || row.runStatus === "CANCELLED",
  );
  const timedOut = input.rows.filter((row) => row.runStatus === "TIMED_OUT").length;
  const evaluatorErrors = input.rows.reduce(
    (sum, row) => sum + row.results.filter((result) => result.status === "ERROR").length,
    0,
  );
  const caseKeys = new Set(input.rows.map((row) => row.caseKey));
  const scoredCases = new Set(
    input.rows.filter((row) => row.aggregateScore !== null).map((row) => row.caseKey),
  );

  return {
    candidateId: input.candidateId,
    label: input.label,
    role: input.role,
    harnessVersionId: input.harnessVersionId,
    harnessVersion: input.harnessVersion,
    caseCount: caseKeys.size,
    executions: input.rows.length,
    plannedExecutions: input.plannedExecutions,
    completed: batchMetrics.cases.completed,
    failed: batchMetrics.cases.failed,
    skipped: batchMetrics.cases.skipped,
    cancelled: batchMetrics.cases.cancelled,
    pending: batchMetrics.cases.pending,
    running: batchMetrics.cases.running,
    scored: batchMetrics.scored,
    unscored: batchMetrics.unscored,
    incomplete: batchMetrics.aggregateStatuses.incomplete,
    score: { mean: batchMetrics.score.mean, median: batchMetrics.score.median },
    passRate: batchMetrics.passRate,
    failureRate:
      batchMetrics.passed + batchMetrics.failed === 0
        ? null
        : batchMetrics.failed / (batchMetrics.passed + batchMetrics.failed),
    passed: batchMetrics.passed,
    failedVerdicts: batchMetrics.failed,
    latency: {
      averageMs: batchMetrics.latency.averageMs,
      medianMs: batchMetrics.latency.medianMs,
      p95Ms: percentile(
        input.rows
          .map((row) => row.latencyMs)
          .filter((value): value is number => value !== null && value >= 0)
          .sort((a, b) => a - b),
        0.95,
      ),
      measured: batchMetrics.latency.measured,
    },
    tokens: batchMetrics.tokens,
    cost: batchMetrics.cost,
    retries: batchMetrics.retries,
    toolInvocations: batchMetrics.toolInvocations,
    toolCallsPerCase: scoredCases.size === 0 ? null : batchMetrics.toolInvocations / scoredCases.size,
    timeoutRate: terminal.length === 0 ? null : timedOut / terminal.length,
    timedOut,
    evaluatorErrors,
    perEvaluator: batchMetrics.perEvaluator,
    evaluatorUsage: batchMetrics.evaluatorUsage,
    batchMetrics,
    errorCategories: countErrorCategories(input.rows),
  };
}

export interface ExperimentMetricsInput {
  plannedExecutions: number;
  caseCount: number;
  policy: BatchMetrics["policy"];
  candidates: readonly CandidateMetricsInput[];
}

export function computeExperimentMetrics(input: ExperimentMetricsInput): ExperimentMetrics {
  const candidates = input.candidates.map(computeCandidateMetrics);
  const completed = candidates.reduce((sum, entry) => sum + entry.completed, 0);
  const failed = candidates.reduce((sum, entry) => sum + entry.failed, 0);
  const skipped = candidates.reduce((sum, entry) => sum + entry.skipped, 0);
  const cancelled = candidates.reduce((sum, entry) => sum + entry.cancelled, 0);
  const running = candidates.reduce((sum, entry) => sum + entry.running, 0);
  const pending = candidates.reduce((sum, entry) => sum + entry.pending, 0);
  const executions = candidates.reduce((sum, entry) => sum + entry.executions, 0);

  return {
    computedAt: new Date().toISOString(),
    plannedExecutions: input.plannedExecutions,
    executions,
    completed,
    failed,
    skipped,
    cancelled,
    running,
    pending,
    complete: pending === 0 && running === 0,
    caseCount: input.caseCount,
    candidates,
  };
}

// ------------------------------------------------------------------------------
// Per-case observations (the alignment unit for every comparison)
// ------------------------------------------------------------------------------

/**
 * Groups one candidate's executions by dataset case.
 *
 * With `replicates = 1` this is a straight projection. With more trials, the
 * case's score is the mean of the trials that produced a score, and the case
 * passes only when every scored trial passed — the conservative reading, so a
 * candidate that is right once in three attempts does not look like a winner.
 */
export function aggregateCaseObservations(input: {
  samples: readonly DatasetCaseSnapshot[];
  rows: readonly CandidateCaseMetricRow[];
}): ExperimentCaseObservation[] {
  const byKey = new Map<string, CandidateCaseMetricRow[]>();
  for (const row of input.rows) {
    const bucket = byKey.get(row.caseKey) ?? [];
    bucket.push(row);
    byKey.set(row.caseKey, bucket);
  }

  const sampleByKey = new Map(input.samples.map((sample, index) => [sample.caseKey, { sample, index }]));
  const keys = new Set<string>([...sampleByKey.keys(), ...byKey.keys()]);

  const observations: ExperimentCaseObservation[] = [];
  for (const caseKey of keys) {
    const found = sampleByKey.get(caseKey);
    const rows = (byKey.get(caseKey) ?? []).sort((a, b) => a.replicate - b.replicate);
    const scores = rows
      .map((row) => row.aggregateScore)
      .filter((value): value is number => value !== null);
    const passVerdicts = rows
      .map((row) => row.passed)
      .filter((value): value is boolean => value !== null);

    observations.push({
      caseKey,
      index: found?.index ?? rows[0]?.index ?? 0,
      name: found?.sample.name ?? null,
      tags: found?.sample.tags ?? [],
      trials: rows.map((row) => ({
        replicate: row.replicate,
        evaluationBatchId: row.evaluationBatchId,
        caseResultId: row.caseResultId,
        status: row.status,
        runId: row.runId,
        aggregateScore: row.aggregateScore,
        aggregateStatus: row.aggregateStatus,
        passed: row.passed,
        attempts: row.attempt,
        error: row.error,
        durationMs: row.latencyMs,
        totalTokens: row.totalTokens,
        toolCalls: row.toolCalls,
        steps: row.stepCount > 0 ? row.stepCount : null,
      })),
      meanScore: scores.length === 0 ? null : average(scores),
      passed:
        passVerdicts.length === 0
          ? null
          : passVerdicts.length === 1
            ? passVerdicts[0] === true
            : passVerdicts.every(Boolean),
      scoredTrials: scores.length,
    });
  }

  return observations.sort((a, b) => a.index - b.index || a.caseKey.localeCompare(b.caseKey));
}

/** Mean of the per-case scores, ignoring cases that produced no score. */
export function meanCaseScore(observations: readonly ExperimentCaseObservation[]): number | null {
  return average(
    observations
      .map((entry) => entry.meanScore)
      .filter((value): value is number => value !== null),
  );
}

/** Median of the per-case scores (per-case, not per-execution). */
export function medianCaseScore(observations: readonly ExperimentCaseObservation[]): number | null {
  return median(
    observations
      .map((entry) => entry.meanScore)
      .filter((value): value is number => value !== null),
  );
}
