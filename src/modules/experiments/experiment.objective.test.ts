import { describe, expect, it } from "vitest";
import {
  checkBudget,
  constraintDefinitions,
  defaultDirection,
  describeConstraints,
  describeObjective,
  evaluateConstraints,
  isExperimentMetricKey,
  validateConstraints,
  validateObjective,
} from "./experiment.objective";
import { computeCandidateMetrics } from "./experiment.metrics";
import type { CandidateMetrics } from "./experiment.metrics";
import {
  EMPTY_EXPERIMENT_CONSTRAINTS,
  EXPERIMENT_METRIC_KEYS,
  type ExperimentConstraints,
} from "./experiment.types";

/**
 * The objective layer decides what "better" means and what a hard limit is. Two
 * rules are load-bearing and are asserted directly:
 *
 *  1. A constraint with no measurement is *unknown*, never satisfied.
 *  2. A budget that cannot be measured (no priced model) neither silently
 *     permits nor silently blocks everything.
 */

function metrics(overrides: Partial<CandidateMetrics> = {}): CandidateMetrics {
  return {
    ...computeCandidateMetrics({
      candidateId: "cand-1",
      label: "Candidate",
      role: "CANDIDATE",
      harnessVersionId: "hv-1",
      harnessVersion: 2,
      policy: "REQUIRE_ALL",
      plannedExecutions: 0,
      rows: [],
    }),
    ...overrides,
  };
}

describe("metric definitions", () => {
  it("knows every metric key and its default direction", () => {
    for (const key of EXPERIMENT_METRIC_KEYS) {
      expect(isExperimentMetricKey(key)).toBe(true);
    }
    expect(isExperimentMetricKey("nope")).toBe(false);
  });

  it("minimizes cost and latency, maximizes score and pass rate", () => {
    expect(defaultDirection("evaluation_score")).toBe("maximize");
    expect(defaultDirection("pass_rate")).toBe("maximize");
    expect(defaultDirection("estimated_cost_usd")).toBe("minimize");
    expect(defaultDirection("median_latency_ms")).toBe("minimize");
  });

  it("reports a token metric as unmeasured when no execution reported usage", () => {
    const unmeasured = metrics({ tokens: { total: 0, reported: 0, unreported: 2 } });
    expect(unmeasured.tokens.reported).toBe(0);
    // The token *definition* must not read "0 reported" as "0 tokens used".
    expect(constraintDefinitions().find((entry) => entry.key === "maxTotalTokens")?.read(unmeasured)).toBeNull();
  });
});

describe("validateObjective", () => {
  it("accepts a well-formed objective", () => {
    expect(
      validateObjective({
        primary: { metric: "evaluation_score", direction: "maximize" },
        secondary: [{ metric: "median_latency_ms", direction: "minimize" }],
      }),
    ).toEqual([]);
  });

  it("rejects an unknown primary metric", () => {
    const issues = validateObjective({
      primary: { metric: "vibes", direction: "maximize" },
      secondary: [],
    });
    expect(issues.some((issue) => issue.path === "objective.primary.metric")).toBe(true);
  });

  it("rejects a metric listed as both primary and secondary", () => {
    const issues = validateObjective({
      primary: { metric: "pass_rate", direction: "maximize" },
      secondary: [{ metric: "pass_rate", direction: "maximize" }],
    });
    expect(issues.some((issue) => issue.message.includes("listed twice"))).toBe(true);
  });

  it("rejects an invalid direction", () => {
    const issues = validateObjective({
      primary: { metric: "pass_rate", direction: "sideways" },
      secondary: [],
    });
    expect(issues.some((issue) => issue.path === "objective.primary.direction")).toBe(true);
  });
});

describe("validateConstraints", () => {
  it("accepts the empty constraint set", () => {
    expect(validateConstraints(EMPTY_EXPERIMENT_CONSTRAINTS)).toEqual([]);
  });

  it("accepts in-range limits", () => {
    expect(
      validateConstraints({ ...EMPTY_EXPERIMENT_CONSTRAINTS, minPassRate: 0.8, maxMedianLatencyMs: 9_000 }),
    ).toEqual([]);
  });

  it("rejects an out-of-range pass-rate floor", () => {
    const issues = validateConstraints({ ...EMPTY_EXPERIMENT_CONSTRAINTS, minPassRate: 1.5 });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("constraints.minPassRate");
  });

  it("rejects an out-of-range cost ceiling", () => {
    const issues = validateConstraints({ ...EMPTY_EXPERIMENT_CONSTRAINTS, maxTotalCostUsd: -1 });
    expect(issues.some((issue) => issue.path === "constraints.maxTotalCostUsd")).toBe(true);
  });
});

describe("evaluateConstraints", () => {
  it("marks a satisfied constraint as satisfied", () => {
    const evaluation = evaluateConstraints(
      metrics({ passRate: 0.9, score: { mean: 0.8, median: 0.8 } }),
      { ...EMPTY_EXPERIMENT_CONSTRAINTS, minPassRate: 0.8 },
    );
    expect(evaluation.constrained).toBe(1);
    expect(evaluation.satisfied).toBe(1);
    expect(evaluation.violated).toBe(0);
    expect(evaluation.eligible).toBe(true);
    expect(evaluation.allMeasured).toBe(true);
  });

  it("marks a violated constraint as violated and explains the numbers", () => {
    const evaluation = evaluateConstraints(
      metrics({ passRate: 0.4 }),
      { ...EMPTY_EXPERIMENT_CONSTRAINTS, minPassRate: 0.8 },
    );
    expect(evaluation.violated).toBe(1);
    expect(evaluation.eligible).toBe(false);
    expect(evaluation.checks[0]?.explanation).toContain("40%");
  });

  it("reports an unmeasured constraint as unknown, never as satisfied", () => {
    const evaluation = evaluateConstraints(
      metrics({ passRate: null, cost: { ...metrics().cost, costUsd: null } }),
      { ...EMPTY_EXPERIMENT_CONSTRAINTS, minPassRate: 0.8, maxTotalCostUsd: 1 },
    );
    expect(evaluation.satisfied).toBe(0);
    expect(evaluation.unknown).toBe(2);
    expect(evaluation.allMeasured).toBe(false);
    // An unknown does not disqualify — it blocks a win, which the ranking layer
    // enforces, but it is not a violation.
    expect(evaluation.eligible).toBe(true);
    expect(evaluation.checks[0]?.satisfied).toBeNull();
  });

  it("ignores limits that were not configured", () => {
    const evaluation = evaluateConstraints(metrics({ passRate: 0.1 }), EMPTY_EXPERIMENT_CONSTRAINTS);
    expect(evaluation.constrained).toBe(0);
    expect(evaluation.checks).toEqual([]);
  });
});

describe("checkBudget", () => {
  const budget = { maxRuns: 3, maxTotalTokens: null, maxCostUsd: null };

  it("allows work while the run budget has room", () => {
    const verdict = checkBudget({ budget, usage: { executionsStarted: 2, totalTokens: 0, costUsd: null } });
    expect(verdict.allowed).toBe(true);
    expect(verdict.kind).toBeNull();
  });

  it("stops at the run budget and names the limit", () => {
    const verdict = checkBudget({ budget, usage: { executionsStarted: 3, totalTokens: 0, costUsd: null } });
    expect(verdict.allowed).toBe(false);
    expect(verdict.kind).toBe("runs");
    expect(verdict.message).toContain("3");
  });

  it("stops at the token budget", () => {
    const verdict = checkBudget({
      budget: { maxRuns: null, maxTotalTokens: 100, maxCostUsd: null },
      usage: { executionsStarted: 1, totalTokens: 150, costUsd: null },
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.kind).toBe("tokens");
  });

  it("stops at the measured cost ceiling", () => {
    const verdict = checkBudget({
      budget: { maxRuns: null, maxTotalTokens: null, maxCostUsd: 0.5 },
      usage: { executionsStarted: 1, totalTokens: 10, costUsd: 0.75 },
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.kind).toBe("cost");
  });

  it("does not treat an unmeasured cost as zero when there is no cost ceiling", () => {
    const verdict = checkBudget({
      budget: { maxRuns: 10, maxTotalTokens: null, maxCostUsd: null },
      usage: { executionsStarted: 1, totalTokens: 10, costUsd: null },
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.observed).toBeNull();
  });

  it("allows an unpriced experiment past a cost ceiling, and says nothing was measured", () => {
    // The honest behaviour: with no priced model, a *cost* ceiling cannot be
    // enforced. The pre-flight warns about this; the orchestrator stops on runs.
    const verdict = checkBudget({
      budget: { maxRuns: null, maxTotalTokens: null, maxCostUsd: 0.5 },
      usage: { executionsStarted: 1, totalTokens: 10, costUsd: null },
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.kind).toBeNull();
    expect(verdict.message).toBeNull();
  });
});

describe("descriptions", () => {
  it("describes the objective in words the review step shows", () => {
    const lines = describeObjective({
      primary: { metric: "evaluation_score", direction: "maximize" },
      secondary: [{ metric: "median_latency_ms", direction: "minimize" }],
    });
    expect(lines[0]).toContain("maximize");
    expect(lines[0]).toContain("Mean evaluation score");
    expect(lines[1]).toContain("minimize");
    expect(lines[1]).toContain("Median latency");
  });

  it("says when there are no secondary metrics instead of implying one", () => {
    const lines = describeObjective({
      primary: { metric: "pass_rate", direction: "maximize" },
      secondary: [],
    });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("No secondary metrics");
  });

  it("describes every configured constraint", () => {
    const constraints: ExperimentConstraints = {
      ...EMPTY_EXPERIMENT_CONSTRAINTS,
      minPassRate: 0.75,
      maxMedianLatencyMs: 8_000,
    };
    const lines = describeConstraints(constraints);
    expect(lines).toHaveLength(2);
    expect(lines.some((line) => line.includes("75%"))).toBe(true);
    expect(lines.some((line) => line.includes("8000 ms"))).toBe(true);
  });

  it("describes no constraints as nothing at all", () => {
    expect(describeConstraints(EMPTY_EXPERIMENT_CONSTRAINTS)).toEqual([]);
  });
});
