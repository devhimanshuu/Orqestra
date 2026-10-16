/**
 * Acceptance policy.
 *
 * The part of Phase 5 that decides. It is deliberately pure: given a baseline's
 * metrics, a candidate's metrics, an objective and a set of hard constraints, it
 * returns a verdict with every reason attached. No database, no clock beyond a
 * timestamp, no model call — so the rules are testable and the decision can be
 * replayed from stored rows.
 *
 * Three principles, in priority order:
 *
 *  1. **Hard constraints outrank scores.** A candidate that breaks a ceiling is
 *     rejected whatever its primary metric says; the reasons say so explicitly.
 *  2. **Insufficient evidence is inconclusive, not success.** Missing metrics, a
 *     batch that did not finish, or too few scored cases never become an
 *     improvement claim.
 *  3. **Observed improvement and statistical confidence are separate facts.** A
 *     large delta on four cases is `indicative`; it is reported as observed, not
 *     as established.
 */

import type { BatchMetrics } from "@/modules/evaluation/metrics";
import type { ExperimentMetricKey, MetricDirection } from "@/modules/experiments/experiment.types";
import type {
  AcceptanceDecision,
  AcceptanceInput,
  ConstraintViolation,
  MetricDelta,
  OptimizationConstraints,
} from "../optimization.types";

/**
 * Cases that must produce a usable score before a candidate can be judged at
 * all. Below this, evaluation is evidence-poor and the verdict is inconclusive.
 */
export const MIN_SCORED_CASES = 3;

/**
 * Paired sample size at which an improvement is treated as statistically
 * established rather than indicative. Mirrors the experiment layer's rule so the
 * two surfaces tell the same story.
 */
export const MIN_ESTABLISHED_SAMPLE = 8;

/** Reads one metric out of a batch's stored metrics. `null` means not measured. */
export function readBatchMetric(
  metrics: BatchMetrics | null,
  key: ExperimentMetricKey,
): number | null {
  if (metrics === null) {
    return null;
  }
  switch (key) {
    case "evaluation_score":
      return metrics.score.mean;
    case "pass_rate":
      return metrics.passRate;
    case "failure_rate":
      return metrics.passRate === null ? null : 1 - metrics.passRate;
    case "median_latency_ms":
      return metrics.latency.medianMs;
    case "p95_latency_ms":
      // The batch metrics do not compute a p95 — reporting one would be invention.
      return null;
    case "average_total_tokens":
      return metrics.tokens.reported === 0 || metrics.cases.total === 0
        ? null
        : metrics.tokens.total / metrics.cases.total;
    case "total_tokens":
      return metrics.tokens.reported === 0 ? null : metrics.tokens.total;
    case "estimated_cost_usd":
      return metrics.cost.costUsd;
    case "tool_calls_per_case":
      return metrics.cases.total === 0 ? null : metrics.toolInvocations / metrics.cases.total;
    default:
      return null;
  }
}

/** Signed movement in the objective's improving direction (positive = better). */
export function improvementOf(
  baseline: number | null,
  candidate: number | null,
  direction: MetricDirection,
): number | null {
  if (baseline === null || candidate === null) {
    return null;
  }
  const raw = candidate - baseline;
  return direction === "maximize" ? raw : -raw;
}

export function computeMetricDeltas(input: {
  primary: { metric: ExperimentMetricKey; direction: MetricDirection };
  secondary: Array<{ metric: ExperimentMetricKey; direction: MetricDirection }>;
  baseline: BatchMetrics | null;
  candidate: BatchMetrics | null;
}): MetricDelta[] {
  const specs = [input.primary, ...input.secondary];
  return specs.map((spec) => {
    const baseline = readBatchMetric(input.baseline, spec.metric);
    const candidate = readBatchMetric(input.candidate, spec.metric);
    const delta = baseline === null || candidate === null ? null : candidate - baseline;
    const relativeDelta =
      baseline === null || candidate === null || baseline === 0
        ? null
        : (candidate - baseline) / Math.abs(baseline);
    const improvement = improvementOf(baseline, candidate, spec.direction);
    return {
      metric: spec.metric,
      direction: spec.direction,
      baseline,
      candidate,
      delta,
      relativeDelta,
      improved: improvement === null ? null : improvement > 0,
    };
  });
}

/**
 * Every hard constraint the candidate breaks, with the measured value and the
 * limit it broke. An unmeasurable value never counts as a violation (and never
 * counts as compliance either — it is simply not evidence).
 */
export function checkConstraints(input: {
  constraints: OptimizationConstraints;
  baseline: BatchMetrics | null;
  candidate: BatchMetrics | null;
  primary: { metric: ExperimentMetricKey; direction: MetricDirection };
}): ConstraintViolation[] {
  const { constraints, baseline, candidate } = input;
  const violations: ConstraintViolation[] = [];
  if (candidate === null) {
    return violations;
  }

  const push = (
    constraint: string,
    message: string,
    observed: number | null,
    limit: number,
  ): void => {
    violations.push({ constraint, message, observed, limit });
  };

  if (constraints.minPassRate !== null && candidate.passRate !== null && candidate.passRate < constraints.minPassRate) {
    push(
      "min_pass_rate",
      `pass rate ${format(candidate.passRate)} is below the required floor ${format(constraints.minPassRate)}`,
      candidate.passRate,
      constraints.minPassRate,
    );
  }

  if (constraints.minMeanScore !== null && candidate.score.mean !== null && candidate.score.mean < constraints.minMeanScore) {
    push(
      "min_mean_score",
      `mean score ${format(candidate.score.mean)} is below the required floor ${format(constraints.minMeanScore)}`,
      candidate.score.mean,
      constraints.minMeanScore,
    );
  }

  if (
    constraints.maxMedianLatencyMs !== null &&
    candidate.latency.medianMs !== null &&
    candidate.latency.medianMs > constraints.maxMedianLatencyMs
  ) {
    push(
      "max_median_latency_ms",
      `median latency ${Math.round(candidate.latency.medianMs)}ms exceeds the ceiling ${constraints.maxMedianLatencyMs}ms`,
      candidate.latency.medianMs,
      constraints.maxMedianLatencyMs,
    );
  }

  if (constraints.maxTotalTokens !== null && candidate.tokens.reported > 0 && candidate.tokens.total > constraints.maxTotalTokens) {
    push(
      "max_total_tokens",
      `${candidate.tokens.total} tokens exceed the ceiling ${constraints.maxTotalTokens}`,
      candidate.tokens.total,
      constraints.maxTotalTokens,
    );
  }

  if (constraints.maxTotalCostUsd !== null && candidate.cost.costUsd !== null && candidate.cost.costUsd > constraints.maxTotalCostUsd) {
    push(
      "max_total_cost_usd",
      `estimated cost $${format(candidate.cost.costUsd)} exceeds the ceiling $${constraints.maxTotalCostUsd}`,
      candidate.cost.costUsd,
      constraints.maxTotalCostUsd,
    );
  }

  // Relative regressions: the question the developer actually asked.
  const baselineCost = baseline?.cost.costUsd ?? null;
  const candidateCost = candidate.cost.costUsd;
  if (
    constraints.maxCostIncreasePct !== null &&
    baselineCost !== null &&
    candidateCost !== null &&
    baselineCost > 0
  ) {
    const increase = (candidateCost - baselineCost) / baselineCost;
    if (increase > constraints.maxCostIncreasePct) {
      push(
        "max_cost_increase_pct",
        `cost rose ${percent(increase)} against the baseline (allowed: ${percent(constraints.maxCostIncreasePct)})`,
        increase,
        constraints.maxCostIncreasePct,
      );
    }
  }

  const baselineLatency = baseline?.latency.medianMs ?? null;
  const candidateLatency = candidate.latency.medianMs;
  if (
    constraints.maxLatencyIncreasePct !== null &&
    baselineLatency !== null &&
    candidateLatency !== null &&
    baselineLatency > 0
  ) {
    const increase = (candidateLatency - baselineLatency) / baselineLatency;
    if (increase > constraints.maxLatencyIncreasePct) {
      push(
        "max_latency_increase_pct",
        `median latency rose ${percent(increase)} against the baseline (allowed: ${percent(constraints.maxLatencyIncreasePct)})`,
        increase,
        constraints.maxLatencyIncreasePct,
      );
    }
  }

  // Quality regression, expressed in the objective's own direction.
  if (constraints.maxQualityRegressionPct !== null) {
    const baselinePrimary = readBatchMetric(baseline, input.primary.metric);
    const candidatePrimary = readBatchMetric(candidate, input.primary.metric);
    const improvement = improvementOf(baselinePrimary, candidatePrimary, input.primary.direction);
    if (improvement !== null && improvement < 0) {
      const regression = -improvement;
      const allowed =
        baselinePrimary === null || baselinePrimary === 0
          ? constraints.maxQualityRegressionPct
          : Math.abs(baselinePrimary) * constraints.maxQualityRegressionPct;
      if (regression > allowed) {
        push(
          "max_quality_regression_pct",
          `${input.primary.metric} regressed by ${format(regression)} against the baseline (allowed: ${format(allowed)})`,
          regression,
          allowed,
        );
      }
    }
  }

  return violations;
}

/** The verdict. */
export function evaluateAcceptance(input: AcceptanceInput): AcceptanceDecision {
  const reasons: string[] = [];
  const deltas = computeMetricDeltas({
    primary: input.objective.primary,
    secondary: input.objective.secondary,
    baseline: input.baseline,
    candidate: input.candidate,
  });

  // --- evidence completeness --------------------------------------------------
  const candidate = input.candidate;
  const executed = candidate === null ? 0 : candidate.cases.total;
  const settled = candidate === null ? 0 : candidate.cases.completed + candidate.cases.failed + candidate.cases.cancelled + candidate.cases.skipped;
  const complete =
    candidate !== null &&
    executed > 0 &&
    executed === input.plannedCases &&
    settled === executed &&
    candidate.cases.cancelled === 0 &&
    candidate.cases.skipped === 0 &&
    candidate.cases.failed === 0;
  const evidenceCompleteness: AcceptanceDecision["evidenceCompleteness"] =
    candidate === null || executed === 0 ? "none" : complete ? "complete" : "partial";

  if (candidate === null) {
    return {
      kind: "INCONCLUSIVE",
      reasons: ["The candidate produced no evaluation metrics, so nothing can be decided."],
      violations: [],
      deltas,
      evidenceCompleteness: "none",
      evidenceStrength: "inconclusive",
      scoredCases: 0,
      evaluatedAt: new Date().toISOString(),
    };
  }

  const scoredCases = candidate.scored;
  if (scoredCases < MIN_SCORED_CASES) {
    return {
      kind: "INCONCLUSIVE",
      reasons: [
        `Only ${scoredCases} case${scoredCases === 1 ? "" : "s"} produced a usable score; at least ${MIN_SCORED_CASES} are required to judge a candidate.`,
        `Candidate batch status: ${input.batchStatus}.`,
      ],
      violations: [],
      deltas,
      evidenceCompleteness,
      evidenceStrength: "inconclusive",
      scoredCases,
      evaluatedAt: new Date().toISOString(),
    };
  }

  // --- hard constraints (authoritative) --------------------------------------
  const violations = checkConstraints({
    constraints: input.constraints,
    baseline: input.baseline,
    candidate,
    primary: input.objective.primary,
  });
  if (violations.length > 0) {
    return {
      kind: "REJECT",
      reasons: [
        ...violations.map((violation) => `Hard constraint broken — ${violation.message}.`),
        "A higher primary metric cannot override a hard constraint.",
      ],
      violations,
      deltas,
      evidenceCompleteness,
      evidenceStrength: "inconclusive",
      scoredCases,
      evaluatedAt: new Date().toISOString(),
    };
  }

  // --- improvement -----------------------------------------------------------
  const baselinePrimary = readBatchMetric(input.baseline, input.objective.primary.metric);
  const candidatePrimary = readBatchMetric(candidate, input.objective.primary.metric);
  if (baselinePrimary === null || candidatePrimary === null) {
    return {
      kind: "INCONCLUSIVE",
      reasons: [
        `The primary metric (${input.objective.primary.metric}) is not measured on ${baselinePrimary === null ? "the baseline" : "the candidate"}, so no comparison is possible.`,
      ],
      violations,
      deltas,
      evidenceCompleteness,
      evidenceStrength: "inconclusive",
      scoredCases,
      evaluatedAt: new Date().toISOString(),
    };
  }

  const improvement = improvementOf(baselinePrimary, candidatePrimary, input.objective.primary.direction) ?? 0;
  const requiredImprovement =
    baselinePrimary === 0 ? 0 : Math.abs(baselinePrimary) * input.objective.minImprovementPct;
  const meetsThreshold = baselinePrimary === 0 ? improvement > 0 : improvement >= requiredImprovement;

  if (!meetsThreshold || improvement <= 0) {
    reasons.push(
      improvement <= 0
        ? `${input.objective.primary.metric} did not improve (${format(baselinePrimary)} → ${format(candidatePrimary)}, ${input.objective.primary.direction}).`
        : `${input.objective.primary.metric} improved by ${format(improvement)}, below the required ${format(requiredImprovement)} (${percent(input.objective.minImprovementPct)}).`,
    );
    if (evidenceCompleteness === "partial") {
      reasons.push("The candidate's evaluation did not cover every planned case, so the result is indicative at best.");
    }
    return {
      kind: "REJECT",
      reasons,
      violations,
      deltas,
      evidenceCompleteness,
      evidenceStrength: scoredCases >= MIN_ESTABLISHED_SAMPLE ? "established" : "indicative",
      scoredCases,
      evaluatedAt: new Date().toISOString(),
    };
  }

  reasons.push(
    `${input.objective.primary.metric} improved from ${format(baselinePrimary)} to ${format(candidatePrimary)} (${format(improvement)} in the ${input.objective.primary.direction} direction).`,
  );
  for (const delta of deltas.slice(1)) {
    if (delta.improved === true && delta.delta !== null) {
      reasons.push(`Secondary metric ${delta.metric} also improved by ${format(delta.delta)}.`);
    } else if (delta.improved === false && delta.delta !== null) {
      reasons.push(`Secondary metric ${delta.metric} moved the other way by ${format(Math.abs(delta.delta))}.`);
    }
  }
  if (evidenceCompleteness === "partial") {
    reasons.push("The candidate's evaluation did not cover every planned case, so the result is indicative at best.");
  }
  const evidenceStrength: AcceptanceDecision["evidenceStrength"] =
    scoredCases >= MIN_ESTABLISHED_SAMPLE && evidenceCompleteness === "complete"
      ? "established"
      : "indicative";
  if (evidenceStrength === "indicative") {
    reasons.push(
      `Evidence strength is indicative: ${scoredCases} scored case${scoredCases === 1 ? "" : "s"} (statistical confidence needs ${MIN_ESTABLISHED_SAMPLE}).`,
    );
  }

  return {
    kind: "ACCEPT",
    reasons,
    violations,
    deltas,
    evidenceCompleteness,
    evidenceStrength,
    scoredCases,
    evaluatedAt: new Date().toISOString(),
  };
}

function format(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
