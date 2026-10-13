import { describe, expect, it } from "vitest";
import {
  MIN_PAIRED_SAMPLE,
  assessEvidence,
  formatInterval,
  pairedTInterval,
  signTest,
  type PairedDifference,
} from "./experiment.statistics";

/**
 * The statistics module is deliberately small and deliberately cautious. These
 * tests pin the behaviour that matters most: it must never report confidence it
 * does not have, and it must say "inconclusive" rather than inventing a verdict.
 */

function differences(values: Array<number | null>): PairedDifference[] {
  return values.map((value, index) => ({
    caseKey: `case-${index}`,
    baseline: value === null ? null : 0.5,
    candidate: value === null ? null : 0.5 + (value ?? 0),
    difference: value,
  }));
}

/** A clean, uniform improvement of +0.2 on every paired case. */
function uniformImprovement(count: number, step = 0.2): PairedDifference[] {
  return differences(Array.from({ length: count }, () => step));
}

describe("pairedTInterval", () => {
  it("reports a narrow interval entirely above zero for a uniform improvement", () => {
    const summary = pairedTInterval(uniformImprovement(10));
    expect(summary.n).toBe(10);
    expect(summary.meanDifference).toBeCloseTo(0.2, 6);
    expect(summary.ciLow).not.toBeNull();
    expect(summary.ciLow).toBeGreaterThan(0);
    expect(summary.ciHigh).toBeGreaterThan(0);
    expect(summary.sufficientSample).toBe(true);
    expect(summary.method).toBe("paired-t");
  });

  it("marks a sample below the documented minimum as insufficient", () => {
    const summary = pairedTInterval(uniformImprovement(MIN_PAIRED_SAMPLE - 1));
    expect(summary.sufficientSample).toBe(false);
    expect(summary.minSample).toBe(MIN_PAIRED_SAMPLE);
  });

  it("ignores differences that were never measured on both sides", () => {
    const summary = pairedTInterval(differences([0.2, 0.2, null, 0.2, null, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, null]));
    expect(summary.n).toBe(9);
    expect(summary.sufficientSample).toBe(true);
  });

  it("widens the interval when the differences disagree", () => {
    const noisy = pairedTInterval(differences([0.9, -0.9, 0.8, -0.8, 0.7, -0.7, 0.6, -0.6, 0.5, -0.5]));
    expect(noisy.ciLow).toBeLessThan(0);
    expect(noisy.ciHigh).toBeGreaterThan(0);
  });

  it("reports zero spread without pretending it is a finding", () => {
    const summary = pairedTInterval(uniformImprovement(8));
    expect(summary.standardDeviation).toBe(0);
    expect(summary.ciLow).toBeCloseTo(0.2, 6);
    expect(summary.ciHigh).toBeCloseTo(0.2, 6);
  });

  it("documents its assumptions", () => {
    const summary = pairedTInterval(uniformImprovement(8));
    expect(summary.assumptions.length).toBeGreaterThan(0);
    expect(summary.assumptions[0]).toContain("paired");
  });
});

describe("signTest", () => {
  it("returns an exact two-sided p-value for a small sample", () => {
    const result = signTest(differences(Array.from({ length: 8 }, () => 0.1)));
    expect(result.method).toBe("exact-binomial");
    expect(result.positive).toBe(8);
    expect(result.negative).toBe(0);
    expect(result.pValue).not.toBeNull();
    // 8 out of 8 in one direction: 2 * (1/2)^8 = 0.0078125, rounded to six
    // decimals as the module documents.
    expect(result.pValue).toBe(0.007813);
  });

  it("returns null when there is nothing to test", () => {
    const result = signTest(differences([0, 0, 0]));
    expect(result.n).toBe(0);
    expect(result.pValue).toBeNull();
    expect(result.method).toBe("not-applicable");
    expect(result.ties).toBe(3);
  });

  it("counts only finite differences", () => {
    const result = signTest(differences([0.1, null, -0.1, 0.1]));
    expect(result.n).toBe(3);
    expect(result.positive).toBe(2);
    expect(result.negative).toBe(1);
  });
});

describe("assessEvidence", () => {
  it("says insufficient sample rather than claiming a difference on 3 cases", () => {
    const assessment = assessEvidence({
      differences: uniformImprovement(3),
      higherIsBetter: true,
    });
    expect(assessment.verdict).toBe("insufficient_sample");
    expect(assessment.explanation).toContain("provisional");
  });

  it("says insufficient sample when no case scored on both sides", () => {
    const assessment = assessEvidence({ differences: [], higherIsBetter: true });
    expect(assessment.verdict).toBe("insufficient_sample");
    expect(assessment.paired.n).toBe(0);
  });

  it("supports a uniform improvement with a confident interval and a agreeing sign test", () => {
    const assessment = assessEvidence({
      differences: uniformImprovement(10),
      higherIsBetter: true,
    });
    expect(assessment.verdict).toBe("supported_improvement");
    expect(assessment.explanation).toContain("95%");
    expect(assessment.signTest.pValue).toBeLessThan(0.05);
  });

  it("supports a regression when the metric is minimized and it went up", () => {
    // Latency: lower is better, and every case got slower.
    const assessment = assessEvidence({
      differences: uniformImprovement(10),
      higherIsBetter: false,
    });
    expect(assessment.verdict).toBe("supported_regression");
  });

  it("supports a regression when the metric is maximized and it went down", () => {
    // Score: higher is better, and every case got worse.
    const assessment = assessEvidence({
      differences: uniformImprovement(10, -0.15),
      higherIsBetter: true,
    });
    expect(assessment.verdict).toBe("supported_regression");
  });

  it("supports an improvement on a minimized metric when it went down", () => {
    const assessment = assessEvidence({
      differences: uniformImprovement(10, -0.15),
      higherIsBetter: false,
    });
    expect(assessment.verdict).toBe("supported_improvement");
  });

  it("reports no difference when every case scored identically", () => {
    const assessment = assessEvidence({
      differences: differences(Array.from({ length: 8 }, () => 0)),
      higherIsBetter: true,
    });
    expect(assessment.verdict).toBe("no_difference");
    expect(assessment.explanation).toContain("identically");
  });

  it("reports inconclusive when the interval crosses zero", () => {
    const assessment = assessEvidence({
      differences: differences([0.4, -0.4, 0.3, -0.3, 0.2, -0.2, 0.1, -0.1, 0.05, -0.05]),
      higherIsBetter: true,
    });
    expect(assessment.verdict).toBe("inconclusive");
  });

  it("reports inconclusive when the sign test contradicts the interval", () => {
    // A few large gains and many small losses: the mean is up, but the sign test
    // does not corroborate it, so no "supported improvement" is claimed.
    const assessment = assessEvidence({
      differences: differences([2, 2, 2, 2, -1, -1, -1, -1, -1, -1, -1, -1]),
      higherIsBetter: true,
    });
    expect(assessment.verdict).not.toBe("supported_improvement");
    expect(["inconclusive", "insufficient_sample"]).toContain(assessment.verdict);
  });

  it("honours a caller-supplied minimum sample", () => {
    const assessment = assessEvidence({
      differences: uniformImprovement(6),
      higherIsBetter: true,
      minSample: 12,
    });
    expect(assessment.verdict).toBe("insufficient_sample");
    expect(assessment.paired.minSample).toBe(12);
  });
});

describe("formatInterval", () => {
  it("formats a measured interval", () => {
    const summary = pairedTInterval(uniformImprovement(10));
    expect(formatInterval(summary)).toMatch(/^\[0\.\d+, 0\.\d+\]$/);
  });

  it("renders an unmeasured interval as a dash, never as zero", () => {
    const summary = pairedTInterval(differences([]));
    expect(formatInterval(summary)).toBe("—");
  });
});
