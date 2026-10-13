import { describe, expect, it } from "vitest";
import { evaluateBudget, measureSpend, staleWindowMs } from "./orchestrator";
import { computeCandidateMetrics, type CandidateMetrics } from "../experiment.metrics";

/**
 * The orchestrator's decision functions, tested without a database: what it
 * spends, when it must stop, and when a RUNNING case is old enough to be
 * considered abandoned.
 */

function metrics(overrides: Partial<CandidateMetrics> = {}): CandidateMetrics {
  return {
    ...computeCandidateMetrics({
      candidateId: "cand-1",
      label: "Candidate",
      role: "CANDIDATE",
      harnessVersionId: "hv-1",
      harnessVersion: 1,
      policy: "REQUIRE_ALL",
      plannedExecutions: 0,
      rows: [],
    }),
    ...overrides,
  };
}

describe("measureSpend", () => {
  it("reports nothing measured before metrics exist", () => {
    expect(measureSpend({ metrics: null })).toEqual({ started: 0, tokens: 0, costUsd: null });
  });

  it("counts started executions as the settled ones plus the in-flight one", () => {
    const spend = measureSpend({
      metrics: {
        completed: 6,
        failed: 1,
        cancelled: 0,
        running: 1,
        candidates: [
          metrics({ completed: 4, failed: 1, running: 1, tokens: { total: 90, reported: 5, unreported: 0 } }),
          metrics({ completed: 2, failed: 0, running: 0, tokens: { total: 110, reported: 2, unreported: 0 } }),
        ],
      },
    });
    expect(spend.started).toBe(8);
    expect(spend.tokens).toBe(200);
  });

  it("refuses to report a cost when any candidate could not be priced", () => {
    const spend = measureSpend({
      metrics: {
        completed: 2,
        failed: 0,
        cancelled: 0,
        running: 0,
        candidates: [
          metrics({ cost: { costUsd: 0.4, complete: true, unpriced: [], sources: ["openai"], kind: "estimated", billedNote: "estimated" } }),
          metrics({ cost: { costUsd: null, complete: false, unpriced: ["gemini:gemini-9"], sources: [], kind: "estimated", billedNote: "estimated" } }),
        ],
      },
    });
    // Unknown is not zero: a partial total must not be presented as the total.
    expect(spend.costUsd).toBeNull();
  });

  it("sums a fully priced cost", () => {
    const spend = measureSpend({
      metrics: {
        completed: 2,
        failed: 0,
        cancelled: 0,
        running: 0,
        candidates: [
          metrics({ cost: { costUsd: 0.25, complete: true, unpriced: [], sources: ["openai"], kind: "estimated", billedNote: "estimated" } }),
          metrics({ cost: { costUsd: 0.5, complete: true, unpriced: [], sources: ["openai"], kind: "estimated", billedNote: "estimated" } }),
        ],
      },
    });
    expect(spend.costUsd).toBeCloseTo(0.75, 6);
  });
});

describe("evaluateBudget", () => {
  const budget = { maxRuns: 5, maxTotalTokens: 1_000, maxCostUsd: null };

  it("allows more work while every budget has room", () => {
    const decision = evaluateBudget({
      budget,
      spend: { started: 3, tokens: 400, costUsd: null },
      startedThisPass: 0,
    });
    expect(decision.stop).toBe(false);
    expect(decision.reasons).toEqual([]);
  });

  it("counts what this pass started on top of what the metrics already recorded", () => {
    const decision = evaluateBudget({
      budget,
      spend: { started: 4, tokens: 400, costUsd: null },
      startedThisPass: 1,
    });
    expect(decision.stop).toBe(true);
    expect(decision.reasons[0]).toContain("run budget");
  });

  it("stops on a measured cost ceiling", () => {
    const decision = evaluateBudget({
      budget: { maxRuns: null, maxTotalTokens: null, maxCostUsd: 0.5 },
      spend: { started: 2, tokens: 100, costUsd: 0.6 },
      startedThisPass: 0,
    });
    expect(decision.stop).toBe(true);
    expect(decision.reasons[0]).toContain("cost");
  });

  it("does not stop on a cost ceiling when no cost was measured", () => {
    const decision = evaluateBudget({
      budget: { maxRuns: null, maxTotalTokens: null, maxCostUsd: 0.5 },
      spend: { started: 2, tokens: 100, costUsd: null },
      startedThisPass: 0,
    });
    expect(decision.stop).toBe(false);
  });
});

describe("staleWindowMs", () => {
  it("never mistakes live work for abandoned work", () => {
    expect(staleWindowMs(1_000)).toBe(15 * 60_000);
  });

  it("scales with the configured per-case timeout", () => {
    expect(staleWindowMs(600_000)).toBe(3 * 600_000);
  });

  it("falls back to the assumed timeout when none is configured", () => {
    expect(staleWindowMs(null)).toBe(15 * 60_000);
  });
});
