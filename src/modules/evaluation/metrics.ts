/**
 * Metrics.
 *
 * Every number here is derived from persisted records — none is invented, and
 * none is faked when data is missing:
 *
 *  - a rate over zero items is `null` (unavailable), not 0 and not 1;
 *  - token totals report how many runs actually reported usage, so a total that
 *    covers 3 of 40 runs cannot be mistaken for the whole picture;
 *  - cost is always an estimate, carrying its source and its unpriced models;
 *  - latency averages and medians skip runs that never started.
 *
 * The functions are pure so the same numbers can be computed for a page, an
 * export, or a test.
 */

import type { RunStatus } from "@/modules/runtime/run.types";
import type { AggregateStatus, EvaluationResultRecord, ScoringPolicy } from "./evaluation.types";
import { meanScore, medianScore } from "./scoring";
import { estimateUsageCost, type CostEstimate, type PricedUsage } from "./pricing";

export function percentile(sortedValues: readonly number[], fraction: number): number | null {
  if (sortedValues.length === 0) {
    return null;
  }
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.round(fraction * (sortedValues.length - 1))),
  );
  return sortedValues[index] ?? null;
}

export function average(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? null;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** One run, reduced to what the metrics need. */
export interface RunMetricRow {
  status: RunStatus;
  latencyMs: number | null;
  /** Tokens reported by the provider; null means "not reported". */
  totalTokens: number | null;
  attempt: number;
  stepCount: number;
  toolCalls: number;
  modelCalls: number;
  /** Usage records, so cost can be re-estimated when a stored cost is absent. */
  usage: PricedUsage[];
  /** Weighted aggregate score, when this run has been evaluated. */
  evaluationScore: number | null;
  evaluationPassed: boolean | null;
}

export interface RunMetrics {
  total: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  timedOut: number;
  queued: number;
  running: number;
  successRate: number | null;
  failureRate: number | null;
  latency: { averageMs: number | null; medianMs: number | null; p95Ms: number | null; measured: number };
  tokens: { total: number; reported: number; unreported: number };
  cost: CostEstimate & { billedNote: "estimated" };
  retries: number;
  toolInvocations: number;
  modelCalls: number;
  steps: number;
  evaluation: { scored: number; mean: number | null; median: number | null; passed: number; failed: number };
}

const EMPTY_RUN_METRICS: RunMetrics = {
  total: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
  timedOut: 0,
  queued: 0,
  running: 0,
  successRate: null,
  failureRate: null,
  latency: { averageMs: null, medianMs: null, p95Ms: null, measured: 0 },
  tokens: { total: 0, reported: 0, unreported: 0 },
  cost: { ...estimateUsageCost([]), billedNote: "estimated" },
  retries: 0,
  toolInvocations: 0,
  modelCalls: 0,
  steps: 0,
  evaluation: { scored: 0, mean: null, median: null, passed: 0, failed: 0 },
};

export function computeRunMetrics(rows: readonly RunMetricRow[]): RunMetrics {
  if (rows.length === 0) {
    return EMPTY_RUN_METRICS;
  }

  const counts: Record<RunStatus, number> = {
    QUEUED: 0,
    RUNNING: 0,
    SUCCEEDED: 0,
    FAILED: 0,
    CANCELLED: 0,
    TIMED_OUT: 0,
  };
  const latencies: number[] = [];
  let tokensTotal = 0;
  let tokensReported = 0;
  let retries = 0;
  let toolInvocations = 0;
  let modelCalls = 0;
  let steps = 0;
  const scores: Array<number | null> = [];
  let passed = 0;
  let failed = 0;
  const usage: PricedUsage[] = [];

  for (const row of rows) {
    counts[row.status] += 1;
    if (row.latencyMs !== null && row.latencyMs >= 0) {
      latencies.push(row.latencyMs);
    }
    if (row.totalTokens !== null) {
      tokensTotal += row.totalTokens;
      tokensReported += 1;
    }
    retries += Math.max(0, row.attempt - 1);
    toolInvocations += row.toolCalls;
    modelCalls += row.modelCalls;
    steps += row.stepCount;
    if (row.evaluationScore !== null) {
      scores.push(row.evaluationScore);
      if (row.evaluationPassed === true) {
        passed += 1;
      } else if (row.evaluationPassed === false) {
        failed += 1;
      }
    }
    usage.push(...row.usage);
  }

  const terminal = counts.SUCCEEDED + counts.FAILED + counts.CANCELLED + counts.TIMED_OUT;
  const sortedLatencies = [...latencies].sort((a, b) => a - b);

  return {
    total: rows.length,
    succeeded: counts.SUCCEEDED,
    failed: counts.FAILED,
    cancelled: counts.CANCELLED,
    timedOut: counts.TIMED_OUT,
    queued: counts.QUEUED,
    running: counts.RUNNING,
    successRate: terminal === 0 ? null : counts.SUCCEEDED / terminal,
    failureRate: terminal === 0 ? null : counts.FAILED / terminal,
    latency: {
      averageMs: average(latencies),
      medianMs: median(latencies),
      p95Ms: percentile(sortedLatencies, 0.95),
      measured: latencies.length,
    },
    tokens: { total: tokensTotal, reported: tokensReported, unreported: rows.length - tokensReported },
    cost: { ...estimateUsageCost(usage), billedNote: "estimated" },
    retries,
    toolInvocations,
    modelCalls,
    steps,
    evaluation: {
      scored: scores.length,
      mean: meanScore(scores),
      median: medianScore(scores),
      passed,
      failed,
    },
  };
}

// ------------------------------------------------------------------------------
// Evaluation batch metrics
// ------------------------------------------------------------------------------

export interface BatchCaseMetricRow {
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "SKIPPED" | "CANCELLED";
  aggregateScore: number | null;
  aggregateStatus: AggregateStatus | null;
  passed: boolean | null;
  /** Run-side observables (null when the case produced no run). */
  latencyMs: number | null;
  totalTokens: number | null;
  attempt: number;
  toolCalls: number;
  usage: PricedUsage[];
  results: EvaluationResultRecord[];
}

export interface EvaluatorMetric {
  evaluatorKey: string;
  evaluatorName: string;
  kind: string;
  /** Cases where this evaluator produced a usable score. */
  scored: number;
  /** Cases where it errored. */
  errors: number;
  /** Cases it skipped (it had nothing to score). */
  skipped: number;
  meanScore: number | null;
  passRate: number | null;
  meanDurationMs: number | null;
}

/**
 * Usage spent *by the evaluators themselves* (LLM judges), kept apart from the
 * agent run's usage so a `llm_judge` never inflates the cost of the thing it is
 * judging. Estimated, like every other cost here.
 */
export interface EvaluatorUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number | null;
  unknownCost: boolean;
}

export const EMPTY_EVALUATOR_USAGE: EvaluatorUsage = {
  calls: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  unknownCost: false,
};

export interface BatchMetrics {
  policy: ScoringPolicy;
  cases: {
    total: number;
    completed: number;
    failed: number;
    skipped: number;
    cancelled: number;
    pending: number;
    running: number;
  };
  /** Of the cases that produced an aggregate score. */
  scored: number;
  unscored: number;
  aggregateStatuses: { complete: number; incomplete: number; failed: number };
  score: { mean: number | null; median: number | null };
  passRate: number | null;
  passed: number;
  failed: number;
  latency: { averageMs: number | null; medianMs: number | null; measured: number };
  tokens: { total: number; reported: number; unreported: number };
  cost: CostEstimate & { billedNote: "estimated" };
  retries: number;
  toolInvocations: number;
  perEvaluator: EvaluatorMetric[];
  evaluatorUsage: EvaluatorUsage;
}

/** Running summary for one evaluator across a batch. */
interface PerEvaluatorAccumulator {
  evaluatorKey: string;
  evaluatorName: string;
  kind: string;
  scored: number;
  errors: number;
  skipped: number;
  scores: number[];
  durations: number[];
  passes: number;
  passTotal: number;
}

export function computeBatchMetrics(input: {
  policy: ScoringPolicy;
  cases: readonly BatchCaseMetricRow[];
}): BatchMetrics {
  const cases = {
    total: input.cases.length,
    completed: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    pending: 0,
    running: 0,
  };
  const aggregateStatuses = { complete: 0, incomplete: 0, failed: 0 };
  const scores: Array<number | null> = [];
  const latencies: number[] = [];
  let tokensTotal = 0;
  let tokensReported = 0;
  let retries = 0;
  let toolInvocations = 0;
  let passed = 0;
  let failed = 0;
  const usage: PricedUsage[] = [];
  const perEvaluator = new Map<string, PerEvaluatorAccumulator>();
  const evaluatorUsage: EvaluatorUsage = { ...EMPTY_EVALUATOR_USAGE };

  for (const metricRow of input.cases) {
    switch (metricRow.status) {
      case "COMPLETED":
        cases.completed += 1;
        break;
      case "FAILED":
        cases.failed += 1;
        break;
      case "SKIPPED":
        cases.skipped += 1;
        break;
      case "CANCELLED":
        cases.cancelled += 1;
        break;
      case "RUNNING":
        cases.running += 1;
        break;
      default:
        cases.pending += 1;
    }

    if (metricRow.aggregateStatus === "COMPLETE") {
      aggregateStatuses.complete += 1;
    } else if (metricRow.aggregateStatus === "INCOMPLETE") {
      aggregateStatuses.incomplete += 1;
    } else if (metricRow.aggregateStatus === "FAILED") {
      aggregateStatuses.failed += 1;
    }

    if (metricRow.aggregateScore !== null) {
      scores.push(metricRow.aggregateScore);
    }
    if (metricRow.passed === true) {
      passed += 1;
    } else if (metricRow.passed === false) {
      failed += 1;
    }
    if (metricRow.latencyMs !== null && metricRow.latencyMs >= 0) {
      latencies.push(metricRow.latencyMs);
    }
    if (metricRow.totalTokens !== null) {
      tokensTotal += metricRow.totalTokens;
      tokensReported += 1;
    }
    retries += Math.max(0, metricRow.attempt - 1);
    toolInvocations += metricRow.toolCalls;
    usage.push(...metricRow.usage);

    for (const result of metricRow.results) {
      let entry = perEvaluator.get(result.evaluatorKey);
      if (entry === undefined) {
        entry = {
          evaluatorKey: result.evaluatorKey,
          evaluatorName: result.evaluatorName,
          kind: result.kind,
          scored: 0,
          errors: 0,
          skipped: 0,
          scores: [],
          durations: [],
          passes: 0,
          passTotal: 0,
        };
        perEvaluator.set(result.evaluatorKey, entry);
      }
      // Judge accounting comes from the result's own metadata, which records
      // provider, tokens and estimated cost for `llm_judge`.
      const metadata = result.metadata ?? {};
      if (metadata["judgement"] === true) {
        evaluatorUsage.calls += 1;
        const promptTokens = typeof metadata["promptTokens"] === "number" ? metadata["promptTokens"] : 0;
        const completionTokens =
          typeof metadata["completionTokens"] === "number" ? metadata["completionTokens"] : 0;
        evaluatorUsage.promptTokens += promptTokens;
        evaluatorUsage.completionTokens += completionTokens;
        evaluatorUsage.totalTokens += promptTokens + completionTokens;
        const costUsd = metadata["costUsd"];
        if (typeof costUsd === "number") {
          evaluatorUsage.costUsd = (evaluatorUsage.costUsd ?? 0) + costUsd;
        } else {
          evaluatorUsage.costUsd = null;
          evaluatorUsage.unknownCost = true;
        }
      }

      if (result.status === "COMPLETED" && result.normalizedScore !== null) {
        entry.scored += 1;
        entry.scores.push(result.normalizedScore);
        entry.durations.push(result.durationMs);
        if (result.passed !== null) {
          entry.passTotal += 1;
          if (result.passed) {
            entry.passes += 1;
          }
        }
      } else if (result.status === "ERROR") {
        entry.errors += 1;
      } else {
        entry.skipped += 1;
      }
    }
  }

  const perEvaluatorMetrics: EvaluatorMetric[] = [...perEvaluator.values()]
    .map((entry) => ({
      evaluatorKey: entry.evaluatorKey,
      evaluatorName: entry.evaluatorName,
      kind: entry.kind,
      scored: entry.scored,
      errors: entry.errors,
      skipped: entry.skipped,
      meanScore: meanScore(entry.scores),
      passRate: entry.passTotal === 0 ? null : entry.passes / entry.passTotal,
      meanDurationMs: average(entry.durations),
    }))
    .sort((a, b) => a.evaluatorKey.localeCompare(b.evaluatorKey));

  const scored = scores.filter((score): score is number => score !== null).length;

  return {
    policy: input.policy,
    cases,
    scored,
    unscored: cases.total - scored,
    aggregateStatuses,
    score: { mean: meanScore(scores), median: medianScore(scores) },
    passRate: passed + failed === 0 ? null : passed / (passed + failed),
    passed,
    failed,
    latency: {
      averageMs: average(latencies),
      medianMs: median(latencies),
      measured: latencies.length,
    },
    tokens: { total: tokensTotal, reported: tokensReported, unreported: cases.total - tokensReported },
    cost: { ...estimateUsageCost(usage), billedNote: "estimated" },
    retries,
    toolInvocations,
    perEvaluator: perEvaluatorMetrics,
    evaluatorUsage: {
      ...evaluatorUsage,
      costUsd: evaluatorUsage.unknownCost ? null : Number((evaluatorUsage.costUsd ?? 0).toFixed(8)),
    },
  };
}
