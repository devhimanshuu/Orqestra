/**
 * Comparison and regression detection.
 *
 * Comparing two evaluations is only meaningful when the test cases line up.
 * This module therefore refuses to guess:
 *
 *  - batches from **different datasets** are not comparable and raise
 *    `EvaluationComparisonError` instead of producing a number;
 *  - cases are aligned by their **stable `caseKey`**, never by position, so an
 *    inserted test case cannot silently shift every comparison by one;
 *  - cases present in only one side are reported as such and excluded from
 *    per-case verdicts — they are not counted as regressions or improvements;
 *  - a delta is `null` when either side is missing or a denominator is zero, so
 *    the UI can render "no data" instead of an infinity.
 *
 * The headline output is the regression list: cases that passed on the baseline
 * and fail on the candidate. That is the question a harness author actually
 * asks, so it is computed directly rather than inferred from score deltas.
 */

import {
  EvaluationComparisonError,
  type AggregateStatus,
} from "./evaluation.types";
import { meanScore } from "./scoring";
import type { CostEstimate } from "./pricing";

export interface ComparableCase {
  caseKey: string;
  name: string | null;
  status: string;
  aggregateScore: number | null;
  aggregateStatus: AggregateStatus | null;
  passed: boolean | null;
}

export interface ComparableBatch {
  id: string;
  label: string | null;
  datasetId: string;
  datasetVersionId: string;
  harnessId: string;
  harnessVersionId: string;
  harnessVersionLabel: number | null;
  status: string;
  scoringPolicy: string;
  passThreshold: number | null;
  caseCount: number;
  completedCount: number;
  failedCount: number;
  metrics: {
    passRate: number | null;
    passed: number;
    failed: number;
    meanScore: number | null;
    medianScore: number | null;
    averageLatencyMs: number | null;
    totalTokens: number;
    tokenReports: number;
    cost: CostEstimate;
    retries: number;
    toolInvocations: number;
    nodeExecutions: number;
    errorCategories: Record<string, number>;
  };
  cases: ComparableCase[];
}

export interface MetricDelta {
  key: string;
  label: string;
  /** Baseline value (null = unavailable, never 0). */
  baseline: number | null;
  candidate: number | null;
  /** candidate − baseline, or null when either side is unavailable. */
  delta: number | null;
  /** Percentage change, or null when the baseline is 0/absent. */
  deltaPercent: number | null;
  /** True when higher is better for this metric. */
  higherIsBetter: boolean;
  direction: "improved" | "regressed" | "unchanged" | "unknown";
  unit: "ratio" | "ms" | "tokens" | "usd" | "count" | "score";
}

export interface CaseRegression {
  caseKey: string;
  name: string | null;
  baselineScore: number | null;
  candidateScore: number | null;
  baselineStatus: string;
  candidateStatus: string;
  /** The candidate's run prose/error, when the case failed for a visible reason. */
  reason: string | null;
}

export interface CaseMovement {
  caseKey: string;
  name: string | null;
  baselinePassed: boolean | null;
  candidatePassed: boolean | null;
  baselineScore: number | null;
  candidateScore: number | null;
  direction: "improved" | "regressed" | "unchanged" | "unknown";
}

export interface BatchComparison {
  baseline: ComparableBatch;
  candidate: ComparableBatch;
  /** Same dataset (versions may differ — that is a legitimate comparison). */
  compatible: true;
  /** True when both sides pin the exact same dataset version. */
  sameDatasetVersion: boolean;
  sameHarnessVersion: boolean;
  alignment: {
    comparableCases: number;
    onlyInBaseline: string[];
    onlyInCandidate: string[];
    /** Cases scored on both sides — the basis for every per-case verdict. */
    scoredOnBoth: number;
  };
  metrics: MetricDelta[];
  regressions: CaseRegression[];
  improvements: CaseMovement[];
  unchanged: number;
  caseMovements: CaseMovement[];
  summary: {
    verdict: "improved" | "regressed" | "mixed" | "unchanged" | "unknown";
    headline: string;
  };
}

function relativeDelta(baseline: number | null, candidate: number | null): { delta: number | null; deltaPercent: number | null } {
  if (baseline === null || candidate === null) {
    return { delta: null, deltaPercent: null };
  }
  const delta = candidate - baseline;
  if (baseline === 0) {
    return { delta: Number(delta.toFixed(6)), deltaPercent: null };
  }
  return { delta: Number(delta.toFixed(6)), deltaPercent: Number(((delta / Math.abs(baseline)) * 100).toFixed(2)) };
}

function directionOf(
  delta: number | null,
  higherIsBetter: boolean,
): MetricDelta["direction"] {
  if (delta === null) {
    return "unknown";
  }
  if (Math.abs(delta) < 1e-9) {
    return "unchanged";
  }
  const positive = delta > 0;
  return positive === higherIsBetter ? "improved" : "regressed";
}

function delta(
  key: string,
  label: string,
  baseline: number | null,
  candidate: number | null,
  options: { higherIsBetter: boolean; unit: MetricDelta["unit"] },
): MetricDelta {
  const { delta: value, deltaPercent } = relativeDelta(baseline, candidate);
  return {
    key,
    label,
    baseline,
    candidate,
    delta: value,
    deltaPercent,
    higherIsBetter: options.higherIsBetter,
    direction: directionOf(value, options.higherIsBetter),
    unit: options.unit,
  };
}

function caseVerdict(movement: CaseMovement): CaseMovement["direction"] {
  if (movement.baselineScore === null || movement.candidateScore === null) {
    return "unknown";
  }
  const value = movement.candidateScore - movement.baselineScore;
  if (Math.abs(value) < 1e-9) {
    return "unchanged";
  }
  return value > 0 ? "improved" : "regressed";
}

/**
 * Compares two batches. Throws when the batches come from different datasets,
 * because aligning unrelated test cases would produce a confident wrong answer.
 */
export function compareBatches(
  baseline: ComparableBatch,
  candidate: ComparableBatch,
): BatchComparison {
  if (baseline.datasetId !== candidate.datasetId) {
    throw new EvaluationComparisonError(
      "These evaluations ran against different datasets, so their test cases are not comparable. Compare batches that share a dataset.",
    );
  }

  const baselineCases = new Map(baseline.cases.map((entry) => [entry.caseKey, entry]));
  const candidateCases = new Map(candidate.cases.map((entry) => [entry.caseKey, entry]));

  const onlyInBaseline: string[] = [];
  const onlyInCandidate: string[] = [];
  const caseMovements: CaseMovement[] = [];
  const regressions: CaseRegression[] = [];
  const improvements: CaseMovement[] = [];
  let unchanged = 0;
  let scoredOnBoth = 0;

  for (const [caseKey, baseCase] of baselineCases) {
    const candidateCase = candidateCases.get(caseKey);
    if (candidateCase === undefined) {
      onlyInBaseline.push(caseKey);
      continue;
    }
    if (baseCase.aggregateScore !== null && candidateCase.aggregateScore !== null) {
      scoredOnBoth += 1;
    }
    const movement: CaseMovement = {
      caseKey,
      name: baseCase.name ?? candidateCase.name,
      baselinePassed: baseCase.passed,
      candidatePassed: candidateCase.passed,
      baselineScore: baseCase.aggregateScore,
      candidateScore: candidateCase.aggregateScore,
      direction: "unknown",
    };
    movement.direction = caseVerdict(movement);
    caseMovements.push(movement);

    if (movement.direction === "unchanged") {
      unchanged += 1;
    } else if (movement.direction === "improved") {
      improvements.push(movement);
    }

    // The regression definition is about pass/fail, not score: a case that
    // passed and now fails is a regression even if its score dropped by 0.01.
    const passRegression = baseCase.passed === true && candidateCase.passed === false;
    const failedNow = candidateCase.status === "FAILED";
    if (passRegression || (baseCase.passed !== false && failedNow)) {
      regressions.push({
        caseKey,
        name: movement.name,
        baselineScore: baseCase.aggregateScore,
        candidateScore: candidateCase.aggregateScore,
        baselineStatus: baseCase.status,
        candidateStatus: candidateCase.status,
        reason: failedNow
          ? "the candidate produced no aggregate score for this case"
          : "the case passed on the baseline and fails on the candidate",
      });
    }
  }

  for (const caseKey of candidateCases.keys()) {
    if (!baselineCases.has(caseKey)) {
      onlyInCandidate.push(caseKey);
    }
  }

  const perCaseScores = (batch: ComparableBatch): Array<number | null> =>
    batch.cases.map((entry) => entry.aggregateScore);

  const metricDeltas: MetricDelta[] = [
    delta("passRate", "Pass rate", baseline.metrics.passRate, candidate.metrics.passRate, {
      higherIsBetter: true,
      unit: "ratio",
    }),
    delta("meanScore", "Mean aggregate score", baseline.metrics.meanScore ?? meanScore(perCaseScores(baseline)), candidate.metrics.meanScore ?? meanScore(perCaseScores(candidate)), {
      higherIsBetter: true,
      unit: "score",
    }),
    delta("medianScore", "Median aggregate score", baseline.metrics.medianScore, candidate.metrics.medianScore, {
      higherIsBetter: true,
      unit: "score",
    }),
    delta("failed", "Failed cases", baseline.metrics.failed, candidate.metrics.failed, {
      higherIsBetter: false,
      unit: "count",
    }),
    delta("completed", "Completed cases", baseline.completedCount, candidate.completedCount, {
      higherIsBetter: true,
      unit: "count",
    }),
    delta("averageLatencyMs", "Average latency", baseline.metrics.averageLatencyMs, candidate.metrics.averageLatencyMs, {
      higherIsBetter: false,
      unit: "ms",
    }),
    delta("totalTokens", "Total tokens", baseline.metrics.totalTokens, candidate.metrics.totalTokens, {
      higherIsBetter: false,
      unit: "tokens",
    }),
    delta("estimatedCostUsd", "Estimated cost", baseline.metrics.cost.costUsd, candidate.metrics.cost.costUsd, {
      higherIsBetter: false,
      unit: "usd",
    }),
    delta("retries", "Retries", baseline.metrics.retries, candidate.metrics.retries, {
      higherIsBetter: false,
      unit: "count",
    }),
    delta("toolInvocations", "Tool invocations", baseline.metrics.toolInvocations, candidate.metrics.toolInvocations, {
      higherIsBetter: false,
      unit: "count",
    }),
    delta("nodeExecutions", "Node executions", baseline.metrics.nodeExecutions, candidate.metrics.nodeExecutions, {
      higherIsBetter: false,
      unit: "count",
    }),
  ];

  const improvedMetrics = metricDeltas.filter((entry) => entry.direction === "improved").length;
  const regressedMetrics = metricDeltas.filter((entry) => entry.direction === "regressed").length;
  const unknownMetrics = metricDeltas.filter((entry) => entry.direction === "unknown").length;

  // Per-case evidence outranks the batch metrics: a case that passed and now
  // fails is a regression even when the averages happen to be identical.
  let verdict: BatchComparison["summary"]["verdict"] = "unchanged";
  if (regressions.length > 0 && improvements.length > 0) {
    verdict = "mixed";
  } else if (regressions.length > 0) {
    verdict = "regressed";
  } else if (improvements.length > 0) {
    verdict = "improved";
  } else if (unknownMetrics === metricDeltas.length) {
    verdict = "unknown";
  } else if (improvedMetrics === 0 && regressedMetrics === 0) {
    verdict = "unchanged";
  } else if (regressedMetrics > improvedMetrics) {
    verdict = "regressed";
  } else if (improvedMetrics > regressedMetrics) {
    verdict = "improved";
  }

  const headline = buildHeadline({
    verdict,
    regressions: regressions.length,
    improvements: improvements.length,
    unchanged,
    comparableCases: caseMovements.length,
    unknownMetrics,
  });

  return {
    baseline,
    candidate,
    compatible: true,
    sameDatasetVersion: baseline.datasetVersionId === candidate.datasetVersionId,
    sameHarnessVersion: baseline.harnessVersionId === candidate.harnessVersionId,
    alignment: {
      comparableCases: caseMovements.length,
      onlyInBaseline: onlyInBaseline.sort(),
      onlyInCandidate: onlyInCandidate.sort(),
      scoredOnBoth,
    },
    metrics: metricDeltas,
    regressions: regressions.sort((a, b) => a.caseKey.localeCompare(b.caseKey)),
    improvements: improvements.sort((a, b) => a.caseKey.localeCompare(b.caseKey)),
    unchanged,
    caseMovements,
    summary: { verdict, headline },
  };
}

function buildHeadline(input: {
  verdict: BatchComparison["summary"]["verdict"];
  regressions: number;
  improvements: number;
  unchanged: number;
  comparableCases: number;
  unknownMetrics: number;
}): string {
  const scope =
    input.comparableCases === 0
      ? "no test cases are present in both evaluations"
      : `${input.comparableCases} comparable test case(s)`;
  switch (input.verdict) {
    case "regressed":
      return `${input.regressions} regression(s) across ${scope}; ${input.improvements} improvement(s).`;
    case "improved":
      return `${input.improvements} improvement(s) across ${scope}; no regressions.`;
    case "mixed":
      return `${input.improvements} improvement(s) and ${input.regressions} regression(s) across ${scope} — review the regression list before promoting.`;
    case "unchanged":
      return `${input.unchanged} case(s) unchanged across ${scope}; no verdict from the batch metrics.`;
    default:
      return `Not enough comparable data: ${scope}${input.unknownMetrics > 0 ? `, and ${input.unknownMetrics} metric(s) are unavailable` : ""}.`;
  }
}
