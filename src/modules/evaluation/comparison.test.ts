import { describe, expect, it } from "vitest";
import { compareBatches, type ComparableBatch, type ComparableCase } from "./comparison";
import { EvaluationComparisonError } from "./evaluation.types";

function makeCase(overrides: Partial<ComparableCase> = {}): ComparableCase {
  return {
    caseKey: "case-1",
    name: "Case 1",
    status: "COMPLETED",
    aggregateScore: 1,
    aggregateStatus: "COMPLETE",
    passed: true,
    ...overrides,
  };
}

function makeBatch(overrides: Partial<ComparableBatch> = {}): ComparableBatch {
  return {
    id: "batch-1",
    label: "Baseline",
    datasetId: "dataset-1",
    datasetVersionId: "dv-1",
    harnessId: "harness-1",
    harnessVersionId: "hv-1",
    harnessVersionLabel: 1,
    status: "COMPLETED",
    scoringPolicy: "REQUIRE_ALL",
    passThreshold: 0.7,
    caseCount: 1,
    completedCount: 1,
    failedCount: 0,
    metrics: {
      passRate: 1,
      passed: 1,
      failed: 0,
      meanScore: 1,
      medianScore: 1,
      averageLatencyMs: 1_000,
      totalTokens: 100,
      tokenReports: 1,
      cost: { costUsd: 0.01, complete: true, unpriced: [], sources: [], kind: "estimated" },
      retries: 0,
      toolInvocations: 1,
      nodeExecutions: 3,
      errorCategories: {},
    },
    cases: [makeCase()],
    ...overrides,
  };
}

describe("compareBatches", () => {
  it("refuses to compare batches from different datasets", () => {
    expect(() =>
      compareBatches(makeBatch({ datasetId: "dataset-1" }), makeBatch({ datasetId: "dataset-2" })),
    ).toThrow(EvaluationComparisonError);
  });

  it("aligns cases by stable key, not by position", () => {
    const baseline = makeBatch({
      cases: [
        makeCase({ caseKey: "a", aggregateScore: 1, passed: true }),
        makeCase({ caseKey: "b", aggregateScore: 1, passed: true }),
      ],
    });
    // A case is inserted at the front of the candidate — positions shift, keys do not.
    const candidate = makeBatch({
      cases: [
        makeCase({ caseKey: "z", aggregateScore: 0, passed: false }),
        makeCase({ caseKey: "b", aggregateScore: 0.4, passed: false }),
        makeCase({ caseKey: "a", aggregateScore: 1, passed: true }),
      ],
    });
    const comparison = compareBatches(baseline, candidate);
    expect(comparison.alignment.onlyInCandidate).toEqual(["z"]);
    expect(comparison.alignment.onlyInBaseline).toEqual([]);
    expect(comparison.alignment.comparableCases).toBe(2);
    expect(comparison.regressions.map((entry) => entry.caseKey)).toEqual(["b"]);
  });

  it("identifies regressions as cases that passed then failed", () => {
    const baseline = makeBatch({
      cases: [makeCase({ caseKey: "a", passed: true, aggregateScore: 0.9 })],
    });
    const candidate = makeBatch({
      cases: [makeCase({ caseKey: "a", passed: false, aggregateScore: 0.2 })],
    });
    const comparison = compareBatches(baseline, candidate);
    expect(comparison.regressions).toHaveLength(1);
    expect(comparison.regressions[0]).toMatchObject({ caseKey: "a", baselineScore: 0.9, candidateScore: 0.2 });
    expect(comparison.summary.verdict).toBe("regressed");
    expect(comparison.summary.headline).toMatch(/regression/i);
  });

  it("flags a case that failed on the candidate as a regression even if the baseline had no verdict", () => {
    const baseline = makeBatch({
      cases: [makeCase({ caseKey: "a", passed: null, status: "SKIPPED", aggregateScore: null, aggregateStatus: "FAILED" })],
    });
    const candidate = makeBatch({
      cases: [makeCase({ caseKey: "a", passed: null, status: "FAILED", aggregateScore: null, aggregateStatus: "FAILED" })],
    });
    const comparison = compareBatches(baseline, candidate);
    expect(comparison.regressions).toHaveLength(1);
    expect(comparison.regressions[0]?.reason).toMatch(/no aggregate score/);
  });

  it("does not treat a case missing from the candidate as a regression", () => {
    const baseline = makeBatch({ cases: [makeCase({ caseKey: "a" }), makeCase({ caseKey: "gone" })] });
    const candidate = makeBatch({ cases: [makeCase({ caseKey: "a" })] });
    const comparison = compareBatches(baseline, candidate);
    expect(comparison.regressions).toHaveLength(0);
    expect(comparison.alignment.onlyInBaseline).toEqual(["gone"]);
  });

  it("reports improvements across comparable cases", () => {
    const baseline = makeBatch({ cases: [makeCase({ caseKey: "a", passed: false, aggregateScore: 0.2 })] });
    const candidate = makeBatch({ cases: [makeCase({ caseKey: "a", passed: true, aggregateScore: 0.95 })] });
    const comparison = compareBatches(baseline, candidate);
    expect(comparison.improvements).toHaveLength(1);
    expect(comparison.regressions).toHaveLength(0);
    expect(comparison.summary.verdict).toBe("improved");
  });

  it("computes absolute and percentage deltas, and refuses to divide by zero", () => {
    const baseline = makeBatch({ metrics: { ...makeBatch().metrics, failed: 0 } });
    const candidate = makeBatch({ metrics: { ...makeBatch().metrics, failed: 2 } });
    const comparison = compareBatches(baseline, candidate);
    const failed = comparison.metrics.find((entry) => entry.key === "failed");
    expect(failed?.delta).toBe(2);
    expect(failed?.deltaPercent).toBeNull();
    expect(failed?.direction).toBe("regressed");

    const latency = comparison.metrics.find((entry) => entry.key === "averageLatencyMs");
    expect(latency?.delta).toBe(0);
    expect(latency?.direction).toBe("unchanged");
  });

  it("reports unknown rather than a fabricated verdict when a metric is unavailable", () => {
    const baseline = makeBatch({ metrics: { ...makeBatch().metrics, averageLatencyMs: null, meanScore: null, medianScore: null, passRate: null } });
    const candidate = makeBatch({ metrics: { ...makeBatch().metrics, averageLatencyMs: null, meanScore: null, medianScore: null, passRate: null } });
    const comparison = compareBatches(baseline, candidate);
    const latency = comparison.metrics.find((entry) => entry.key === "averageLatencyMs");
    expect(latency?.delta).toBeNull();
    expect(latency?.direction).toBe("unknown");
  });

  it("detects a mixed result and says so", () => {
    const baseline = makeBatch({
      cases: [makeCase({ caseKey: "a", passed: true, aggregateScore: 0.8 }), makeCase({ caseKey: "b", passed: false, aggregateScore: 0.3 })],
    });
    const candidate = makeBatch({
      cases: [makeCase({ caseKey: "a", passed: false, aggregateScore: 0.2 }), makeCase({ caseKey: "b", passed: true, aggregateScore: 0.9 })],
    });
    const comparison = compareBatches(baseline, candidate);
    expect(comparison.summary.verdict).toBe("mixed");
    expect(comparison.regressions.map((entry) => entry.caseKey)).toEqual(["a"]);
    expect(comparison.improvements.map((entry) => entry.caseKey)).toEqual(["b"]);
  });

  it("notes when both sides pin the same dataset and harness version", () => {
    const same = compareBatches(makeBatch(), makeBatch({ id: "batch-2" }));
    expect(same.sameDatasetVersion).toBe(true);
    expect(same.sameHarnessVersion).toBe(true);

    const newerDataset = compareBatches(
      makeBatch(),
      makeBatch({ id: "batch-3", datasetVersionId: "dv-2" }),
    );
    expect(newerDataset.sameDatasetVersion).toBe(false);
    expect(newerDataset.compatible).toBe(true);
  });

  it("reports no comparable cases honestly", () => {
    const comparison = compareBatches(
      makeBatch({ cases: [makeCase({ caseKey: "a" })] }),
      makeBatch({ cases: [makeCase({ caseKey: "b" })] }),
    );
    expect(comparison.alignment.comparableCases).toBe(0);
    expect(comparison.summary.headline).toMatch(/no test cases are present in both/);
  });
});
