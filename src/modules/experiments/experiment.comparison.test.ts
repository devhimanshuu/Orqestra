import { describe, expect, it } from "vitest";
import { compareMetric, detectRegressions, pathChanges } from "./experiment.comparison";
import type { ExperimentCaseObservation } from "./experiment.types";

/**
 * Comparison rules that the UI depends on directly:
 *
 *  - a percentage change against a zero or missing baseline is *null*, not
 *    Infinity and not 0;
 *  - a regression is a per-case verdict, not an average that moved;
 *  - a changed execution path is a lead, never a verdict.
 */

describe("compareMetric", () => {
  it("reports an improvement on a maximized metric", () => {
    const result = compareMetric({
      key: "evaluation_score",
      label: "Mean evaluation score",
      higherIsBetter: true,
      baseline: 0.5,
      candidate: 0.75,
    });
    expect(result.direction).toBe("improved");
    expect(result.delta).toBeCloseTo(0.25, 6);
    // Percentage changes are already multiplied by 100, so a caller cannot
    // accidentally render 5000% where it means 50%.
    expect(result.deltaPercent).toBe(50);
    expect(result.explanation).toContain("+50%");
  });

  it("reports a regression on a maximized metric", () => {
    const result = compareMetric({
      key: "evaluation_score",
      label: "Mean evaluation score",
      higherIsBetter: true,
      baseline: 0.8,
      candidate: 0.6,
    });
    expect(result.direction).toBe("regressed");
  });

  it("flips the direction for a minimized metric", () => {
    const slower = compareMetric({
      key: "median_latency_ms",
      label: "Median latency",
      higherIsBetter: false,
      baseline: 1_000,
      candidate: 1_500,
    });
    expect(slower.direction).toBe("regressed");

    const faster = compareMetric({
      key: "median_latency_ms",
      label: "Median latency",
      higherIsBetter: false,
      baseline: 1_000,
      candidate: 800,
    });
    expect(faster.direction).toBe("improved");
  });

  it("reports an unchanged metric as unchanged, not as improved", () => {
    const result = compareMetric({
      key: "evaluation_score",
      label: "Mean evaluation score",
      higherIsBetter: true,
      baseline: 0.5,
      candidate: 0.5,
    });
    expect(result.direction).toBe("unchanged");
    expect(result.delta).toBe(0);
  });

  it("has no percentage when the baseline is zero", () => {
    const result = compareMetric({
      key: "evaluation_score",
      label: "Mean evaluation score",
      higherIsBetter: true,
      baseline: 0,
      candidate: 0.5,
    });
    expect(result.delta).toBeCloseTo(0.5, 6);
    expect(result.deltaPercent).toBeNull();
  });

  it("is unknown — not zero — when either side was never measured", () => {
    const missingBaseline = compareMetric({
      key: "evaluation_score",
      label: "Mean evaluation score",
      higherIsBetter: true,
      baseline: null,
      candidate: 0.5,
    });
    expect(missingBaseline.direction).toBe("unknown");
    expect(missingBaseline.delta).toBeNull();
    expect(missingBaseline.deltaPercent).toBeNull();
    expect(missingBaseline.explanation).toContain("baseline");

    const missingCandidate = compareMetric({
      key: "evaluation_score",
      label: "Mean evaluation score",
      higherIsBetter: true,
      baseline: 0.5,
      candidate: null,
    });
    expect(missingCandidate.direction).toBe("unknown");
    expect(missingCandidate.explanation).toContain("candidate");
  });
});

function observation(
  caseKey: string,
  overrides: Partial<ExperimentCaseObservation> = {},
): ExperimentCaseObservation {
  return {
    caseKey,
    index: 0,
    name: null,
    tags: [],
    trials: [],
    meanScore: null,
    passed: null,
    scoredTrials: 0,
    ...overrides,
  };
}

function trial(
  replicate: number,
  overrides: Partial<ExperimentCaseObservation["trials"][number]> = {},
): ExperimentCaseObservation["trials"][number] {
  return {
    replicate,
    evaluationBatchId: "batch-1",
    caseResultId: "result-1",
    status: "COMPLETED",
    runId: `run-${replicate}`,
    aggregateScore: null,
    aggregateStatus: null,
    passed: null,
    attempts: 1,
    error: null,
    durationMs: 1_000,
    totalTokens: 100,
    toolCalls: 1,
    steps: 3,
    ...overrides,
  };
}

describe("detectRegressions", () => {
  it("flags a case that passed on the baseline and fails on the candidate", () => {
    const findings = detectRegressions({
      baseline: [observation("a", { meanScore: 1, passed: true, scoredTrials: 1, trials: [trial(1, { passed: true, aggregateScore: 1 })] })],
      candidate: [observation("a", { meanScore: 0.2, passed: false, scoredTrials: 1, trials: [trial(1, { passed: false, aggregateScore: 0.2 })] })],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("pass_to_fail");
    expect(findings[0]?.isRegression).toBe(true);
    expect(findings[0]?.caseKey).toBe("a");
  });

  it("does not invent a regression for a case that improved", () => {
    const findings = detectRegressions({
      baseline: [observation("a", { meanScore: 0, passed: false, scoredTrials: 1, trials: [trial(1)] })],
      candidate: [observation("a", { meanScore: 1, passed: true, scoredTrials: 1, trials: [trial(1)] })],
    });
    expect(findings).toHaveLength(0);
  });

  it("flags a quality decline between two passing cases", () => {
    const findings = detectRegressions({
      baseline: [observation("a", { meanScore: 0.9, passed: true, scoredTrials: 1, trials: [trial(1)] })],
      candidate: [observation("a", { meanScore: 0.6, passed: true, scoredTrials: 1, trials: [trial(1)] })],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("score_decline");
    expect(findings[0]?.detail).toContain("0.900");
  });

  it("flags a failed candidate execution as a missing verdict", () => {
    const findings = detectRegressions({
      baseline: [observation("a", { meanScore: 0.5, passed: true, scoredTrials: 1, trials: [trial(1)] })],
      candidate: [
        observation("a", {
          meanScore: null,
          passed: null,
          scoredTrials: 0,
          trials: [trial(1, { status: "FAILED", aggregateScore: null, passed: null })],
        }),
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("missing_verdict");
    expect(findings[0]?.isRegression).toBe(true);
  });

  it("reports a changed execution path as a lead, not a verdict", () => {
    const findings = detectRegressions({
      baseline: [observation("a", { meanScore: 0.8, passed: true, scoredTrials: 1, trials: [trial(1, { steps: 3 })] })],
      candidate: [observation("a", { meanScore: 0.8, passed: true, scoredTrials: 1, trials: [trial(1, { steps: 7 })] })],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("execution_path_changed");
    expect(findings[0]?.isRegression).toBe(false);
    expect(pathChanges(findings)).toHaveLength(1);
  });

  it("reports a path lead alongside a verdict-level regression, not instead of it", () => {
    const findings = detectRegressions({
      baseline: [
        observation("a", {
          meanScore: 1,
          passed: true,
          scoredTrials: 1,
          trials: [trial(1, { passed: true, aggregateScore: 1, steps: 5 })],
        }),
      ],
      candidate: [
        observation("a", {
          meanScore: 0.2,
          passed: false,
          scoredTrials: 1,
          trials: [trial(1, { passed: false, aggregateScore: 0.2, steps: 2 })],
        }),
      ],
    });
    expect(findings).toHaveLength(2);
    expect(findings.map((entry) => entry.kind).sort()).toEqual([
      "execution_path_changed",
      "pass_to_fail",
    ]);
    expect(findings.find((entry) => entry.kind === "pass_to_fail")?.isRegression).toBe(true);
    expect(findings.find((entry) => entry.kind === "execution_path_changed")?.isRegression).toBe(false);
    expect(pathChanges(findings)).toHaveLength(1);
  });

  it("can be asked to skip path-change detection", () => {
    const findings = detectRegressions({
      baseline: [observation("a", { meanScore: 0.8, passed: true, trials: [trial(1, { steps: 3 })] })],
      candidate: [observation("a", { meanScore: 0.8, passed: true, trials: [trial(1, { steps: 7 })] })],
      detectPathChanges: false,
    });
    expect(findings).toHaveLength(0);
  });

  it("ignores cases that exist on only one side", () => {
    const findings = detectRegressions({
      baseline: [observation("a", { meanScore: 1, passed: true })],
      candidate: [observation("b", { meanScore: 0, passed: false })],
    });
    expect(findings).toHaveLength(0);
  });

  it("sorts verdicts ahead of leads", () => {
    const findings = detectRegressions({
      baseline: [
        observation("a", { meanScore: 1, passed: true }),
        observation("z", { meanScore: 0.9, passed: true, trials: [trial(1, { steps: 3 })] }),
      ],
      candidate: [
        observation("a", { meanScore: 0, passed: false, trials: [trial(1, { steps: 9 })] }),
        observation("z", { meanScore: 0.9, passed: true, trials: [trial(1, { steps: 2 })] }),
      ],
    });
    expect(findings[0]?.isRegression).toBe(true);
    expect(findings[1]?.isRegression).toBe(false);
  });
});
