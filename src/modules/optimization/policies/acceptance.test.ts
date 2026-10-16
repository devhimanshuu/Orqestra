import { describe, expect, it } from "vitest";
import type { BatchMetrics } from "@/modules/evaluation/metrics";
import type { OptimizationObjective } from "../optimization.types";
import {
  MIN_ESTABLISHED_SAMPLE,
  MIN_SCORED_CASES,
  checkConstraints,
  evaluateAcceptance,
  improvementOf,
  readBatchMetric,
} from "./acceptance";

/**
 * The acceptance policy is the part of the loop that says yes or no, so its
 * rules are pinned here:
 *
 *  - no metrics, or too few scored cases, is *inconclusive* — never a pass;
 *  - a hard constraint beats a better primary metric, always;
 *  - an improvement below the required threshold is a rejection, not a pass;
 *  - evidence strength (indicative vs established) is reported separately from
 *    the verdict, so a 3-case win is never claimed as proven;
 *  - a baseline of zero requires strictly more than zero to count as a win.
 */

function metrics(overrides: Partial<BatchMetrics> = {}): BatchMetrics {
  return {
    policy: "REQUIRE_ALL",
    cases: { total: 10, completed: 10, failed: 0, skipped: 0, cancelled: 0, pending: 0, running: 0 },
    scored: 10,
    unscored: 0,
    aggregateStatuses: { complete: 10, incomplete: 0, failed: 0 },
    score: { mean: 0.5, median: 0.5 },
    passRate: 0.4,
    passed: 4,
    failed: 6,
    latency: { averageMs: 120, medianMs: 110, measured: 10 },
    tokens: { total: 1_000, reported: 10, unreported: 0 },
    cost: {
      costUsd: 0.4,
      complete: true,
      unpriced: [],
      sources: ["test"],
      kind: "estimated",
      billedNote: "estimated",
    },
    retries: 0,
    toolInvocations: 5,
    perEvaluator: [],
    evaluatorUsage: {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      unknownCost: false,
    },
    ...overrides,
  };
}

const objective: OptimizationObjective = {
  primary: { metric: "evaluation_score", direction: "maximize" },
  secondary: [{ metric: "estimated_cost_usd", direction: "minimize" }],
  minImprovementPct: 0,
  notes: null,
};

function input(overrides: Partial<Parameters<typeof evaluateAcceptance>[0]> = {}) {
  return {
    objective,
    constraints: {
      minPassRate: null,
      minMeanScore: null,
      maxMedianLatencyMs: null,
      maxTotalTokens: null,
      maxTotalCostUsd: null,
      maxCostIncreasePct: null,
      maxLatencyIncreasePct: null,
      maxQualityRegressionPct: null,
    },
    baseline: metrics(),
    candidate: metrics({ score: { mean: 0.7, median: 0.7 } }),
    plannedCases: 10,
    batchStatus: "COMPLETED",
    baselineScoredCases: 10,
    ...overrides,
  };
}

describe("evaluateAcceptance", () => {
  it("is inconclusive when the candidate produced no metrics at all", () => {
    const decision = evaluateAcceptance(input({ candidate: null }));
    expect(decision.kind).toBe("INCONCLUSIVE");
    expect(decision.evidenceCompleteness).toBe("none");
    expect(decision.reasons[0]).toContain("no evaluation metrics");
  });

  it("is inconclusive below the minimum scored sample, and says how many it got", () => {
    const decision = evaluateAcceptance(
      input({ candidate: metrics({ scored: MIN_SCORED_CASES - 1 }) }),
    );
    expect(decision.kind).toBe("INCONCLUSIVE");
    expect(decision.scoredCases).toBe(MIN_SCORED_CASES - 1);
    expect(decision.reasons[0]).toContain(`${MIN_SCORED_CASES}`);
  });

  it("rejects a candidate that breaks a hard constraint even when it scores higher", () => {
    const decision = evaluateAcceptance(
      input({
        constraints: { ...input().constraints, minPassRate: 0.8 },
        candidate: metrics({ score: { mean: 0.99, median: 0.99 }, passRate: 0.4 }),
      }),
    );
    expect(decision.kind).toBe("REJECT");
    expect(decision.violations).toHaveLength(1);
    expect(decision.violations[0]?.constraint).toBe("min_pass_rate");
    expect(decision.reasons.join(" ")).toContain("Hard constraint broken");
  });

  it("rejects when the primary metric did not improve", () => {
    const decision = evaluateAcceptance(
      input({ candidate: metrics({ score: { mean: 0.5, median: 0.5 } }) }),
    );
    expect(decision.kind).toBe("REJECT");
    expect(decision.reasons[0]).toContain("did not improve");
  });

  it("accepts an improvement, but labels a small sample indicative rather than established", () => {
    const decision = evaluateAcceptance(
      input({ candidate: metrics({ scored: 3, score: { mean: 0.7, median: 0.7 } }) }),
    );
    expect(decision.kind).toBe("ACCEPT");
    expect(decision.evidenceStrength).toBe("indicative");
    expect(decision.reasons.join(" ")).toContain(`${MIN_ESTABLISHED_SAMPLE}`);
  });

  it("calls a large, complete sample established", () => {
    const decision = evaluateAcceptance(
      input({ candidate: metrics({ scored: 12, score: { mean: 0.7, median: 0.7 } }) }),
    );
    expect(decision.kind).toBe("ACCEPT");
    expect(decision.evidenceStrength).toBe("established");
    expect(decision.evidenceCompleteness).toBe("complete");
  });

  it("marks a partial evaluation as partial evidence in an otherwise accepted verdict", () => {
    const decision = evaluateAcceptance(
      input({
        candidate: metrics({
          cases: { total: 10, completed: 8, failed: 2, skipped: 0, cancelled: 0, pending: 0, running: 0 },
          score: { mean: 0.9, median: 0.9 },
        }),
      }),
    );
    expect(decision.kind).toBe("ACCEPT");
    expect(decision.evidenceCompleteness).toBe("partial");
    expect(decision.reasons.join(" ")).toContain("indicative at best");
  });

  it("requires strictly more than zero when the baseline is zero", () => {
    const flat = evaluateAcceptance(
      input({
        baseline: metrics({ score: { mean: 0, median: 0 } }),
        candidate: metrics({ score: { mean: 0, median: 0 } }),
      }),
    );
    expect(flat.kind).toBe("REJECT");

    const moving = evaluateAcceptance(
      input({
        baseline: metrics({ score: { mean: 0, median: 0 } }),
        candidate: metrics({ score: { mean: 0.3, median: 0.3 } }),
      }),
    );
    expect(moving.kind).toBe("ACCEPT");
  });

  it("enforces the configured improvement threshold, not just the sign", () => {
    const decision = evaluateAcceptance(
      input({
        objective: { ...objective, minImprovementPct: 0.5 },
        baseline: metrics({ score: { mean: 0.5, median: 0.5 } }),
        candidate: metrics({ score: { mean: 0.6, median: 0.6 } }),
      }),
    );
    expect(decision.kind).toBe("REJECT");
    expect(decision.reasons[0]).toContain("below the required");
  });

  it("reports the deltas it decided on", () => {
    const decision = evaluateAcceptance(input());
    const primary = decision.deltas.find((delta) => delta.metric === "evaluation_score");
    expect(primary?.baseline).toBe(0.5);
    expect(primary?.candidate).toBe(0.7);
    expect(primary?.improved).toBe(true);
  });
});

describe("checkConstraints", () => {
  const primary = { metric: "evaluation_score" as const, direction: "maximize" as const };

  it("flags a cost regression against the configured ceiling", () => {
    const violations = checkConstraints({
      constraints: { ...input().constraints, maxCostIncreasePct: 0.2 },
      baseline: metrics({ cost: { ...metrics().cost, costUsd: 1 } }),
      candidate: metrics({ cost: { ...metrics().cost, costUsd: 2 } }),
      primary,
    });
    expect(violations.map((violation) => violation.constraint)).toContain("max_cost_increase_pct");
  });

  it("reports nothing for an unmeasured value instead of inventing compliance", () => {
    const violations = checkConstraints({
      constraints: { ...input().constraints, minPassRate: 0.9 },
      baseline: metrics({ passRate: null }),
      candidate: metrics({ passRate: null }),
      primary,
    });
    expect(violations).toHaveLength(0);
  });

  it("returns no violations when the candidate has no metrics", () => {
    const violations = checkConstraints({
      constraints: { ...input().constraints, minPassRate: 0.9 },
      baseline: metrics(),
      candidate: null,
      primary,
    });
    expect(violations).toHaveLength(0);
  });
});

describe("readBatchMetric", () => {
  it("answers null rather than zero for a metric it cannot measure", () => {
    expect(readBatchMetric(null, "evaluation_score")).toBeNull();
    expect(readBatchMetric(metrics(), "p95_latency_ms")).toBeNull();
  });

  it("derives failure rate from pass rate", () => {
    expect(readBatchMetric(metrics({ passRate: 0.25 }), "failure_rate")).toBeCloseTo(0.75);
    expect(readBatchMetric(metrics({ passRate: null }), "failure_rate")).toBeNull();
  });
});

describe("improvementOf", () => {
  it("is direction-aware", () => {
    expect(improvementOf(0.4, 0.6, "maximize")).toBeCloseTo(0.2);
    expect(improvementOf(0.4, 0.6, "minimize")).toBeCloseTo(-0.2);
    expect(improvementOf(0.4, null, "maximize")).toBeNull();
  });
});
