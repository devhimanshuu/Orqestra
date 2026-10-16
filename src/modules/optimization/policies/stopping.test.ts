import { describe, expect, it } from "vitest";
import { DEFAULT_OPTIMIZATION_LIMITS, type OptimizationLimits, type StoppingInput } from "../optimization.types";
import { evaluateStopping, fitsRunBudget, projectedRuns } from "./stopping";

/**
 * The loop must stop when it is told to, in a predictable order, and always with
 * a reason a human can read back. These tests pin the ordering (cancel > budgets
 * > progress) and the boundary of every ceiling, because an off-by-one here is
 * how an optimization quietly overspends.
 */

function input(overrides: Partial<StoppingInput> = {}): StoppingInput {
  return {
    limits: { ...DEFAULT_OPTIMIZATION_LIMITS },
    iterationsCompleted: 0,
    candidateCount: 0,
    runCount: 0,
    tokenUsage: 0,
    estimatedCostUsd: 0,
    elapsedMs: 0,
    consecutiveInvalid: 0,
    stallIterations: 0,
    remainingHypotheses: 3,
    cancelRequested: false,
    ...overrides,
  };
}

function limits(overrides: Partial<OptimizationLimits> = {}): OptimizationLimits {
  return { ...DEFAULT_OPTIMIZATION_LIMITS, ...overrides };
}

describe("evaluateStopping", () => {
  it("keeps running while every ceiling is respected", () => {
    const verdict = evaluateStopping(input());
    expect(verdict).toEqual({ stop: false, reason: null, notes: [] });
  });

  it("lets cancellation win over every other reason", () => {
    const verdict = evaluateStopping(
      input({ cancelRequested: true, iterationsCompleted: 99, remainingHypotheses: 0 }),
    );
    expect(verdict.stop).toBe(true);
    expect(verdict.reason).toBe("cancelled");
  });

  it("stops exactly at the iteration ceiling, not one iteration past it", () => {
    expect(evaluateStopping(input({ iterationsCompleted: 2, limits: limits({ maxIterations: 3 }) })).stop).toBe(false);
    expect(evaluateStopping(input({ iterationsCompleted: 3, limits: limits({ maxIterations: 3 }) }))).toEqual({
      stop: true,
      reason: "max_iterations",
      notes: ["Reached the configured iteration limit (3)."],
    });
  });

  it("enforces the candidate, run, token, cost and time ceilings", () => {
    expect(
      evaluateStopping(input({ candidateCount: 6, limits: limits({ maxCandidates: 6 }) })).reason,
    ).toBe("max_candidates");
    expect(evaluateStopping(input({ runCount: 60, limits: limits({ maxRuns: 60 }) })).reason).toBe(
      "max_runs",
    );
    expect(
      evaluateStopping(
        input({ tokenUsage: 1_000, limits: limits({ maxTotalTokens: 1_000 }) }),
      ).reason,
    ).toBe("token_budget");
    expect(
      evaluateStopping(input({ estimatedCostUsd: 2, limits: limits({ maxCostUsd: 2 }) })).reason,
    ).toBe("cost_budget");
    expect(
      evaluateStopping(input({ elapsedMs: 5_000, limits: limits({ maxElapsedMs: 5_000 }) })).reason,
    ).toBe("time_budget");
  });

  it("ignores a budget that was never configured", () => {
    const verdict = evaluateStopping(
      input({ tokenUsage: 9_999_999, estimatedCostUsd: 999, elapsedMs: 10_000_000 }),
    );
    expect(verdict.stop).toBe(false);
  });

  it("stops when the strategy cannot produce a runnable change", () => {
    const verdict = evaluateStopping(
      input({ consecutiveInvalid: 3, limits: limits({ maxConsecutiveInvalid: 3 }) }),
    );
    expect(verdict.reason).toBe("consecutive_invalid");
    expect(verdict.notes[0]).toContain("not producing runnable changes");
  });

  it("stops when the evidence is exhausted, before complaining about progress", () => {
    const verdict = evaluateStopping(input({ remainingHypotheses: 0 }));
    expect(verdict.reason).toBe("no_hypotheses");
  });

  it("stops after the configured number of iterations without an accepted improvement", () => {
    const verdict = evaluateStopping(
      input({ stallIterations: 2, limits: limits({ stallIterations: 2 }) }),
    );
    expect(verdict.reason).toBe("no_improvement");
    expect(verdict.notes[0]).toContain("without an accepted improvement");
  });

  it("orders budgets above progress heuristics", () => {
    const verdict = evaluateStopping(
      input({
        runCount: 60,
        stallIterations: 9,
        remainingHypotheses: 0,
        limits: limits({ maxRuns: 60, stallIterations: 1 }),
      }),
    );
    expect(verdict.reason).toBe("max_runs");
  });
});

describe("fitsRunBudget", () => {
  it("allows an evaluation that exactly fills the remaining budget", () => {
    expect(fitsRunBudget({ runCount: 3, maxRuns: 6, plannedCases: 3 })).toBe(true);
    expect(fitsRunBudget({ runCount: 4, maxRuns: 6, plannedCases: 3 })).toBe(false);
    expect(fitsRunBudget({ runCount: 0, maxRuns: 2, plannedCases: 3 })).toBe(false);
  });
});

describe("projectedRuns", () => {
  it("never projects a negative or zero-candidate cost", () => {
    expect(projectedRuns(10, 3)).toBe(30);
    expect(projectedRuns(-5, 2)).toBe(0);
    expect(projectedRuns(10, 0)).toBe(10);
  });
});
