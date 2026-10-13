/**
 * Objectives, constraints, and budget accounting.
 *
 * An experiment answers one question — "is this candidate better, under these
 * rules?" — so the rules have to be data, not prose:
 *
 *   objective   — the primary metric to optimize, plus secondary metrics that
 *                 are reported alongside it (never silently blended into it);
 *   constraints — hard limits a winner must respect. A candidate that breaks
 *                 one is *ineligible*: ranking must never hand the win to a
 *                 candidate that is cheaper, faster or better only because it
 *                 violated the rules the author set;
 *   budget      — a ceiling on how much the experiment may spend (runs, tokens,
 *                 estimated cost). It is enforced against measured usage,
 *                 because cost cannot be known before the cases have run.
 *
 * Nothing here is a composite score unless the author explicitly configured
 * weights; the default is a transparent comparison on one metric.
 */

import type { ExperimentMetricKey, ExperimentConstraints, ExperimentExecution, MetricDirection } from "./experiment.types";
import type { CandidateMetrics } from "./experiment.metrics";

export interface MetricDefinition {
  key: ExperimentMetricKey;
  label: string;
  unit: "score" | "ratio" | "ms" | "tokens" | "usd" | "count";
  /** Which direction is an improvement, absent an explicit author choice. */
  higherIsBetter: boolean;
  /** Reads the metric from a candidate's metrics; null = not measured. */
  read: (metrics: CandidateMetrics) => number | null;
  /** Human formatting used in ranking explanations. */
  format: (value: number) => string;
}

/** Tokens are only meaningful when at least one execution reported usage. */
function reportedTokens(metrics: CandidateMetrics): number | null {
  return metrics.tokens.reported === 0 ? null : metrics.tokens.total;
}

export const METRIC_DEFINITIONS: Record<ExperimentMetricKey, MetricDefinition> = {
  evaluation_score: {
    key: "evaluation_score",
    label: "Mean evaluation score",
    unit: "score",
    higherIsBetter: true,
    read: (metrics) => metrics.score.mean,
    format: (value) => value.toFixed(3),
  },
  pass_rate: {
    key: "pass_rate",
    label: "Pass rate",
    unit: "ratio",
    higherIsBetter: true,
    read: (metrics) => metrics.passRate,
    format: (value) => `${Math.round(value * 100)}%`,
  },
  failure_rate: {
    key: "failure_rate",
    label: "Failure rate",
    unit: "ratio",
    higherIsBetter: false,
    read: (metrics) => metrics.failureRate,
    format: (value) => `${Math.round(value * 100)}%`,
  },
  median_latency_ms: {
    key: "median_latency_ms",
    label: "Median latency",
    unit: "ms",
    higherIsBetter: false,
    read: (metrics) => metrics.latency.medianMs,
    format: (value) => `${Math.round(value)} ms`,
  },
  p95_latency_ms: {
    key: "p95_latency_ms",
    label: "p95 latency",
    unit: "ms",
    higherIsBetter: false,
    read: (metrics) => metrics.latency.p95Ms,
    format: (value) => `${Math.round(value)} ms`,
  },
  average_total_tokens: {
    key: "average_total_tokens",
    label: "Average tokens per execution",
    unit: "tokens",
    higherIsBetter: false,
    read: (metrics) => (metrics.tokens.reported === 0 ? null : metrics.tokens.total / metrics.tokens.reported),
    format: (value) => `${Math.round(value)} tokens`,
  },
  total_tokens: {
    key: "total_tokens",
    label: "Total tokens",
    unit: "tokens",
    higherIsBetter: false,
    read: reportedTokens,
    format: (value) => `${Math.round(value)} tokens`,
  },
  estimated_cost_usd: {
    key: "estimated_cost_usd",
    label: "Estimated cost",
    unit: "usd",
    higherIsBetter: false,
    read: (metrics) => metrics.cost.costUsd,
    format: (value) => `$${value.toFixed(4)}`,
  },
  tool_calls_per_case: {
    key: "tool_calls_per_case",
    label: "Tool calls per case",
    unit: "count",
    higherIsBetter: false,
    read: (metrics) => metrics.toolCallsPerCase,
    format: (value) => value.toFixed(2),
  },
};

export function isExperimentMetricKey(value: string): value is ExperimentMetricKey {
  return Object.prototype.hasOwnProperty.call(METRIC_DEFINITIONS, value);
}

export function metricDefinition(key: ExperimentMetricKey): MetricDefinition {
  return METRIC_DEFINITIONS[key];
}

export function defaultDirection(key: ExperimentMetricKey): MetricDirection {
  return METRIC_DEFINITIONS[key].higherIsBetter ? "maximize" : "minimize";
}

export interface ObjectiveIssue {
  path: string;
  message: string;
}

export function validateObjective(objective: {
  primary: { metric: string; direction: string };
  secondary: Array<{ metric: string; direction: string }>;
}): ObjectiveIssue[] {
  const issues: ObjectiveIssue[] = [];
  if (!isExperimentMetricKey(objective.primary.metric)) {
    issues.push({ path: "objective.primary.metric", message: `Unknown metric "${objective.primary.metric}"` });
  }
  if (objective.primary.direction !== "maximize" && objective.primary.direction !== "minimize") {
    issues.push({
      path: "objective.primary.direction",
      message: "The primary direction must be maximize or minimize",
    });
  }
  const seen = new Set<string>([objective.primary.metric]);
  for (const [index, entry] of objective.secondary.entries()) {
    if (!isExperimentMetricKey(entry.metric)) {
      issues.push({ path: `objective.secondary.${index}.metric`, message: `Unknown metric "${entry.metric}"` });
      continue;
    }
    if (seen.has(entry.metric)) {
      issues.push({
        path: `objective.secondary.${index}.metric`,
        message: `"${entry.metric}" is listed twice — a metric is either primary or secondary, not both`,
      });
    }
    seen.add(entry.metric);
    if (entry.direction !== "maximize" && entry.direction !== "minimize") {
      issues.push({
        path: `objective.secondary.${index}.direction`,
        message: "A secondary direction must be maximize or minimize",
      });
    }
  }
  return issues;
}

// ------------------------------------------------------------------------------
// Constraints
// ------------------------------------------------------------------------------

interface ConstraintDefinition {
  key: keyof ExperimentConstraints;
  label: string;
  unit: "usd" | "ms" | "ratio" | "score" | "tokens" | "count";
  kind: "at_most" | "at_least";
  read: (metrics: CandidateMetrics) => number | null;
  format: (value: number) => string;
  /** Sanity bounds for validation (min, max) or null when unbounded. */
  bounds: { min: number; max: number } | null;
}

const CONSTRAINT_DEFINITIONS: ConstraintDefinition[] = [
  {
    key: "maxTotalCostUsd",
    label: "Estimated cost ceiling",
    unit: "usd",
    kind: "at_most",
    read: (metrics) => metrics.cost.costUsd,
    format: (value) => `$${value.toFixed(4)}`,
    bounds: { min: 0, max: 10_000 },
  },
  {
    key: "maxMedianLatencyMs",
    label: "Median latency ceiling",
    unit: "ms",
    kind: "at_most",
    read: (metrics) => metrics.latency.medianMs,
    format: (value) => `${Math.round(value)} ms`,
    bounds: { min: 1, max: 3_600_000 },
  },
  {
    key: "minPassRate",
    label: "Minimum pass rate",
    unit: "ratio",
    kind: "at_least",
    read: (metrics) => metrics.passRate,
    format: (value) => `${Math.round(value * 100)}%`,
    bounds: { min: 0, max: 1 },
  },
  {
    key: "minMeanScore",
    label: "Minimum mean score",
    unit: "score",
    kind: "at_least",
    read: (metrics) => metrics.score.mean,
    format: (value) => value.toFixed(3),
    bounds: { min: 0, max: 1 },
  },
  {
    key: "maxTotalTokens",
    label: "Total token ceiling",
    unit: "tokens",
    kind: "at_most",
    read: reportedTokens,
    format: (value) => `${Math.round(value)} tokens`,
    bounds: { min: 1, max: 1_000_000_000 },
  },
  {
    key: "maxToolCallsPerCase",
    label: "Tool calls per case ceiling",
    unit: "count",
    kind: "at_most",
    read: (metrics) => metrics.toolCallsPerCase,
    format: (value) => value.toFixed(2),
    bounds: { min: 0, max: 1_000 },
  },
];

export function constraintDefinitions(): readonly ConstraintDefinition[] {
  return CONSTRAINT_DEFINITIONS;
}

export function validateConstraints(constraints: ExperimentConstraints): ObjectiveIssue[] {
  const issues: ObjectiveIssue[] = [];
  for (const definition of CONSTRAINT_DEFINITIONS) {
    const value = constraints[definition.key];
    if (value === null) {
      continue;
    }
    if (!Number.isFinite(value)) {
      issues.push({ path: `constraints.${definition.key}`, message: `${definition.label} must be a number` });
      continue;
    }
    if (definition.bounds !== null && (value < definition.bounds.min || value > definition.bounds.max)) {
      issues.push({
        path: `constraints.${definition.key}`,
        message: `${definition.label} must be between ${definition.bounds.min} and ${definition.bounds.max}`,
      });
    }
  }
  return issues;
}

export interface ConstraintCheck {
  key: keyof ExperimentConstraints;
  label: string;
  kind: "at_most" | "at_least";
  limit: number;
  unit: ConstraintDefinition["unit"];
  actual: number | null;
  /** true = within the limit, false = violated, null = not measurable yet. */
  satisfied: boolean | null;
  explanation: string;
}

export interface ConstraintEvaluation {
  /** How many constraints were configured at all. */
  constrained: number;
  satisfied: number;
  violated: number;
  unknown: number;
  /** No constraint is violated. Unknown values do not disqualify (but do block a win). */
  eligible: boolean;
  /** Every configured constraint could be measured. */
  allMeasured: boolean;
  checks: ConstraintCheck[];
}

/**
 * Evaluates the configured constraints against a candidate's metrics.
 *
 * A constraint with no measurement is reported as `unknown`, never as passed:
 * "we have not measured cost yet" and "cost is under the limit" must not look
 * the same to a reader deciding whether to promote a candidate.
 */
export function evaluateConstraints(
  metrics: CandidateMetrics,
  constraints: ExperimentConstraints,
): ConstraintEvaluation {
  const checks: ConstraintCheck[] = [];
  for (const definition of CONSTRAINT_DEFINITIONS) {
    const limit = constraints[definition.key];
    if (limit === null) {
      continue;
    }
    const actual = definition.read(metrics);
    let satisfied: boolean | null = null;
    if (actual !== null) {
      satisfied = definition.kind === "at_most" ? actual <= limit : actual >= limit;
    }
    const comparison = definition.kind === "at_most" ? "at most" : "at least";
    const explanation =
      actual === null
        ? `${definition.label}: not measured yet (limit is ${comparison} ${definition.format(limit)}).`
        : satisfied === true
          ? `${definition.label}: ${definition.format(actual)} — within the ${comparison} ${definition.format(limit)} limit.`
          : `${definition.label}: ${definition.format(actual)} — exceeds the ${comparison} ${definition.format(limit)} limit.`;
    checks.push({
      key: definition.key,
      label: definition.label,
      kind: definition.kind,
      limit,
      unit: definition.unit,
      actual,
      satisfied,
      explanation,
    });
  }

  const satisfied = checks.filter((check) => check.satisfied === true).length;
  const violated = checks.filter((check) => check.satisfied === false).length;
  const unknown = checks.filter((check) => check.satisfied === null).length;

  return {
    constrained: checks.length,
    satisfied,
    violated,
    unknown,
    eligible: violated === 0,
    allMeasured: unknown === 0,
    checks,
  };
}

/** Human-readable constraint list, used by the wizard's pre-flight summary. */
export function describeConstraints(constraints: ExperimentConstraints): string[] {
  const lines: string[] = [];
  for (const definition of CONSTRAINT_DEFINITIONS) {
    const limit = constraints[definition.key];
    if (limit === null) {
      continue;
    }
    const comparison = definition.kind === "at_most" ? "must stay at or below" : "must stay at or above";
    lines.push(`${definition.label}: every candidate ${comparison} ${definition.format(limit)}.`);
  }
  return lines;
}

/** The sketch of a comparison that will be made, used for pre-flight review. */
export function describeObjective(objective: {
  primary: { metric: ExperimentMetricKey; direction: MetricDirection };
  secondary: Array<{ metric: ExperimentMetricKey; direction: MetricDirection }>;
}): string[] {
  const directionWord = (direction: MetricDirection): string => (direction === "maximize" ? "maximize" : "minimize");
  const lines = [
    `Primary: ${directionWord(objective.primary.direction)} ${METRIC_DEFINITIONS[objective.primary.metric].label}.`,
  ];
  for (const secondary of objective.secondary) {
    lines.push(`Secondary: ${directionWord(secondary.direction)} ${METRIC_DEFINITIONS[secondary.metric].label}.`);
  }
  if (lines.length === 1) {
    lines.push("No secondary metrics — candidates are compared on the primary metric plus their constraint status.");
  }
  return lines;
}

// ------------------------------------------------------------------------------
// Execution planning and budgets
// ------------------------------------------------------------------------------

export interface PlannedExecution {
  candidateCount: number;
  caseCount: number;
  replicates: number;
  /** Executions that will be created: cases × candidates × replicates. */
  plannedExecutions: number;
  /** True when the configured budget forbids planning this many executions. */
  exceedsRunBudget: boolean;
  runBudget: number | null;
  notes: string[];
}

export function planExecution(input: {
  candidateCount: number;
  caseCount: number;
  execution: ExperimentExecution;
}): PlannedExecution {
  const replicates = Math.max(1, input.execution.replicates);
  const plannedExecutions = input.candidateCount * input.caseCount * replicates;
  const runBudget = input.execution.budget.maxRuns;
  const exceedsRunBudget = runBudget !== null && plannedExecutions > runBudget;
  const notes: string[] = [];

  if (replicates > 1) {
    notes.push(
      `Each case is executed ${replicates} times per candidate; a case counts as passed only when every scored trial passed.`,
    );
  }
  if (runBudget !== null) {
    notes.push(`The run budget allows ${runBudget} execution(s); this configuration plans ${plannedExecutions}.`);
  }
  if (input.execution.budget.maxCostUsd !== null) {
    notes.push(
      "The cost ceiling is enforced against measured usage while the experiment runs — a cost cannot be known before the cases execute.",
    );
  }
  if (input.execution.budget.maxTotalTokens !== null) {
    notes.push("The token ceiling is enforced against usage reported by the provider; unreported usage cannot be counted.");
  }

  return {
    candidateCount: input.candidateCount,
    caseCount: input.caseCount,
    replicates,
    plannedExecutions,
    exceedsRunBudget,
    runBudget,
    notes,
  };
}

export interface BudgetUsage {
  executionsStarted: number;
  totalTokens: number;
  costUsd: number | null;
}

export interface BudgetVerdict {
  allowed: boolean;
  kind: "runs" | "tokens" | "cost" | null;
  limit: number | null;
  observed: number | null;
  message: string | null;
}

/**
 * Decides whether one more execution may start.
 *
 * Cost and token ceilings are checked against *measured* usage: an execution that
 * has already run cannot be un-spent, so the check is "may we start another?".
 * A null cost (no priced model) is treated as "cannot be counted", and the
 * limitation is reported rather than silently allowing or blocking everything.
 */
export function checkBudget(input: {
  budget: ExperimentExecution["budget"];
  usage: BudgetUsage;
}): BudgetVerdict {
  const { budget, usage } = input;

  if (budget.maxRuns !== null && usage.executionsStarted >= budget.maxRuns) {
    return {
      allowed: false,
      kind: "runs",
      limit: budget.maxRuns,
      observed: usage.executionsStarted,
      message: `The run budget of ${budget.maxRuns} execution(s) is exhausted.`,
    };
  }

  if (budget.maxTotalTokens !== null && usage.totalTokens > budget.maxTotalTokens) {
    return {
      allowed: false,
      kind: "tokens",
      limit: budget.maxTotalTokens,
      observed: usage.totalTokens,
      message: `The token budget of ${budget.maxTotalTokens} tokens is exhausted (measured: ${usage.totalTokens}).`,
    };
  }

  if (budget.maxCostUsd !== null && usage.costUsd !== null && usage.costUsd > budget.maxCostUsd) {
    return {
      allowed: false,
      kind: "cost",
      limit: budget.maxCostUsd,
      observed: usage.costUsd,
      message: `The estimated cost ceiling of $${budget.maxCostUsd.toFixed(4)} is exhausted (measured estimate: $${usage.costUsd.toFixed(4)}).`,
    };
  }

  return { allowed: true, kind: null, limit: null, observed: null, message: null };
}
