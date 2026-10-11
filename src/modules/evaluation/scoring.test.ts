import { describe, expect, it } from "vitest";
import {
  aggregateResults,
  meanScore,
  medianScore,
  normalizeScoreValue,
  normalizeWeights,
} from "./scoring";
import { makeResult } from "./testing/fixtures";
import type { EvaluationResultRecord } from "./evaluation.types";

const assignments = [
  { evaluatorKey: "answer@1", weight: 0.5 },
  { evaluatorKey: "harness@1", weight: 0.25 },
  { evaluatorKey: "tools@1", weight: 0.15 },
  { evaluatorKey: "format@1", weight: 0.1 },
];

function results(scores: Record<string, number | null>): EvaluationResultRecord[] {
  return Object.entries(scores).map(([key, score]) =>
    makeResult({
      evaluatorKey: key,
      status: score === null ? "SKIPPED" : "COMPLETED",
      score,
      normalizedScore: score,
      passed: score === null ? null : score >= 0.5,
    }),
  );
}

describe("normalizeScoreValue", () => {
  it("normalises to 0…1", () => {
    expect(normalizeScoreValue(7, 10)).toBeCloseTo(0.7);
    expect(normalizeScoreValue(0, 5)).toBe(0);
    expect(normalizeScoreValue(5, 5)).toBe(1);
  });

  it("rejects impossible scores rather than clamping silently", () => {
    expect(() => normalizeScoreValue(11, 10)).toThrow(/exceeds its maximum/);
    expect(() => normalizeScoreValue(-1, 10)).toThrow(/cannot be negative/);
    expect(() => normalizeScoreValue(1, 0)).toThrow(/positive maximum/);
    expect(() => normalizeScoreValue(Number.NaN, 1)).toThrow(/finite/);
  });
});

describe("normalizeWeights", () => {
  it("normalises weights to sum to 1", () => {
    const { weights } = normalizeWeights(assignments);
    expect([...weights.values()].reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1);
    expect(weights.get("answer@1")).toBeCloseTo(0.5);
  });

  it("applies equal weights when nothing is weighted, and says so", () => {
    const { weights, equalWeightsApplied } = normalizeWeights([
      { evaluatorKey: "a", weight: 0 },
      { evaluatorKey: "b", weight: 0 },
    ]);
    expect(equalWeightsApplied).toBe(true);
    expect(weights.get("a")).toBeCloseTo(0.5);
    expect(weights.get("b")).toBeCloseTo(0.5);
  });
});

describe("aggregateResults", () => {
  it("computes the weighted mean across every evaluator with a score", () => {
    const aggregate = aggregateResults({
      assignments,
      results: results({ "answer@1": 1, "harness@1": 0.8, "tools@1": 0.5, "format@1": 1 }),
    });
    // 0.5*1 + 0.25*0.8 + 0.15*0.5 + 0.1*1 = 0.875
    expect(aggregate.status).toBe("COMPLETE");
    expect(aggregate.score).toBeCloseTo(0.875, 5);
    expect(aggregate.passed).toBe(true);
  });

  it("marks the aggregate INCOMPLETE under REQUIRE_ALL instead of scoring a missing evaluator as zero", () => {
    const aggregate = aggregateResults({
      assignments,
      results: results({ "answer@1": 1, "harness@1": null, "tools@1": 1, "format@1": 1 }),
      policy: "REQUIRE_ALL",
    });
    expect(aggregate.status).toBe("INCOMPLETE");
    expect(aggregate.score).toBeNull();
    expect(aggregate.missing).toEqual(["harness@1"]);
    expect(aggregate.explanation).toMatch(/REQUIRE_ALL/);
    // The results that did arrive are still visible.
    expect(aggregate.contributions.find((entry) => entry.evaluatorKey === "answer@1")?.normalizedScore).toBe(1);
  });

  it("renormalises over the evaluators that scored under IGNORE_MISSING", () => {
    const aggregate = aggregateResults({
      assignments,
      results: results({ "answer@1": 1, "harness@1": null, "tools@1": 1, "format@1": 1 }),
      policy: "IGNORE_MISSING",
    });
    // weights 0.5 + 0.15 + 0.1 = 0.75, all scoring 1 → 1
    expect(aggregate.status).toBe("INCOMPLETE");
    expect(aggregate.score).toBeCloseTo(1);
    expect(aggregate.missing).toEqual(["harness@1"]);
  });

  it("reports FAILED when no evaluator produced a score", () => {
    const aggregate = aggregateResults({
      assignments,
      results: results({ "answer@1": null, "harness@1": null, "tools@1": null, "format@1": null }),
      policy: "IGNORE_MISSING",
    });
    expect(aggregate.status).toBe("FAILED");
    expect(aggregate.score).toBeNull();
    expect(aggregate.passed).toBeNull();
  });

  it("separates errored evaluators from skipped ones", () => {
    const aggregate = aggregateResults({
      assignments: [{ evaluatorKey: "a", weight: 1 }],
      results: [
        makeResult({ evaluatorKey: "a", status: "ERROR", score: null, normalizedScore: null }),
      ],
    });
    expect(aggregate.errored).toEqual(["a"]);
    expect(aggregate.status).toBe("FAILED");
  });

  it("applies the pass threshold when one is configured", () => {
    const pass = aggregateResults({ assignments, results: results({ "answer@1": 0.8 }), policy: "IGNORE_MISSING", passThreshold: 0.7 });
    const fail = aggregateResults({ assignments, results: results({ "answer@1": 0.6 }), policy: "IGNORE_MISSING", passThreshold: 0.7 });
    expect(pass.passed).toBe(true);
    expect(fail.passed).toBe(false);
  });

  it("derives pass/fail from the evaluators' own verdicts when no threshold is set", () => {
    const allPassed = aggregateResults({
      assignments: [{ evaluatorKey: "a", weight: 1 }, { evaluatorKey: "b", weight: 1 }],
      results: [
        makeResult({ evaluatorKey: "a", normalizedScore: 0.9, passed: true }),
        makeResult({ evaluatorKey: "b", normalizedScore: 0.6, passed: true }),
      ],
    });
    const mixed = aggregateResults({
      assignments: [{ evaluatorKey: "a", weight: 1 }, { evaluatorKey: "b", weight: 1 }],
      results: [
        makeResult({ evaluatorKey: "a", normalizedScore: 0.9, passed: true }),
        makeResult({ evaluatorKey: "b", normalizedScore: 0.4, passed: false }),
      ],
    });
    expect(allPassed.passed).toBe(true);
    expect(mixed.passed).toBe(false);
  });

  it("leaves passed unknown when an evaluator has no verdict and no threshold exists", () => {
    const aggregate = aggregateResults({
      assignments: [{ evaluatorKey: "a", weight: 1 }],
      results: [makeResult({ evaluatorKey: "a", normalizedScore: 0.5, passed: null })],
      policy: "IGNORE_MISSING",
    });
    expect(aggregate.passed).toBeNull();
  });

  it("handles an empty evaluator set without inventing a score", () => {
    const aggregate = aggregateResults({ assignments: [], results: [] });
    expect(aggregate.score).toBeNull();
    expect(aggregate.status).toBe("FAILED");
    expect(aggregate.explanation).toMatch(/No evaluators/);
  });

  it("weights a single evaluator to 1 regardless of its raw weight", () => {
    const aggregate = aggregateResults({
      assignments: [{ evaluatorKey: "a", weight: 1_000 }],
      results: results({ "a": 0.4 }),
    });
    expect(aggregate.score).toBeCloseTo(0.4);
  });
});

describe("meanScore / medianScore", () => {
  it("ignores nulls and returns null when nothing scored", () => {
    expect(meanScore([1, null, 0.5])).toBeCloseTo(0.75);
    expect(meanScore([null, null])).toBeNull();
    expect(medianScore([1, 0.5, 0.25])).toBe(0.5);
    expect(medianScore([1, 0.5, 0.25, 0])).toBe(0.375);
    expect(medianScore([])).toBeNull();
  });
});
