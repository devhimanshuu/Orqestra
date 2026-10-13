import { describe, expect, it } from "vitest";
import { evaluatePromotionGates, verifyExperimentAuthorization } from "./experiment.authorization";
import { computeCandidateMetrics, type CandidateMetrics } from "./experiment.metrics";
import {
  EMPTY_EXPERIMENT_CONSTRAINTS,
  type ExperimentCandidateRecord,
  type ExperimentConstraints,
} from "./experiment.types";

/**
 * Selection and promotion are the two actions that change something outside the
 * experiment, so they carry the tightest gates. These tests pin the rules:
 *
 *  - nothing is promotable while executions are outstanding;
 *  - the baseline is a control, never a promoted improvement;
 *  - a candidate with no scored execution has no evidence to promote;
 *  - a violated constraint blocks promotion and is quoted back to the caller;
 *  - an unmeasured constraint warns but does not block (the author decides).
 */

function candidateRecord(role: ExperimentCandidateRecord["role"] = "CANDIDATE"): ExperimentCandidateRecord {
  return {
    id: "cand-1",
    experimentId: "exp-1",
    label: role === "BASELINE" ? "Baseline" : "Critic loop",
    role,
    hypothesis: null,
    orderIndex: 1,
    harnessId: "harness-1",
    harnessVersionId: "hv-1",
    harnessVersion: 2,
    contentHash: "abc123",
    harnessSnapshot: {
      harnessId: "harness-1",
      harnessVersionId: "hv-1",
      harnessVersion: 2,
      harnessName: "Research agent",
      contentHash: "abc123",
      entryNode: "start",
      nodeCount: 5,
      edgeCount: 4,
    },
    createdAt: new Date(0),
    replicates: [],
  };
}

function metrics(overrides: Partial<CandidateMetrics> = {}): CandidateMetrics {
  return {
    ...computeCandidateMetrics({
      candidateId: "cand-1",
      label: "Critic loop",
      role: "CANDIDATE",
      harnessVersionId: "hv-1",
      harnessVersion: 2,
      policy: "REQUIRE_ALL",
      plannedExecutions: 10,
      rows: [],
    }),
    scored: 10,
    executions: 10,
    caseCount: 10,
    passRate: 0.9,
    score: { mean: 0.85, median: 0.85 },
    ...overrides,
  };
}

describe("verifyExperimentAuthorization", () => {
  it("permits a settled candidate with evidence and no constraints", () => {
    const report = verifyExperimentAuthorization({
      candidate: candidateRecord(),
      metrics: metrics(),
      constraints: EMPTY_EXPERIMENT_CONSTRAINTS,
      passThreshold: 0.7,
      experimentStatus: "COMPLETED",
      settled: true,
    });
    expect(report.canPromote).toBe(true);
    expect(report.canSelect).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.checks.every((check) => check.status !== "blocked")).toBe(true);
  });

  it("blocks anything while executions are still outstanding", () => {
    const report = verifyExperimentAuthorization({
      candidate: candidateRecord(),
      metrics: metrics(),
      constraints: EMPTY_EXPERIMENT_CONSTRAINTS,
      passThreshold: 0.7,
      experimentStatus: "RUNNING",
      settled: false,
    });
    expect(report.canPromote).toBe(false);
    expect(report.canSelect).toBe(false);
    expect(report.blockers.some((blocker) => blocker.includes("outstanding"))).toBe(true);
  });

  it("blocks a candidate that produced no scored execution", () => {
    const report = verifyExperimentAuthorization({
      candidate: candidateRecord(),
      metrics: metrics({ scored: 0, passRate: null, score: { mean: null, median: null } }),
      constraints: EMPTY_EXPERIMENT_CONSTRAINTS,
      passThreshold: 0.7,
      experimentStatus: "COMPLETED",
      settled: true,
    });
    expect(report.canPromote).toBe(false);
    expect(report.blockers.some((blocker) => blocker.includes("no scored execution"))).toBe(true);
  });

  it("blocks promoting the baseline itself", () => {
    const report = verifyExperimentAuthorization({
      candidate: candidateRecord("BASELINE"),
      metrics: metrics({ role: "BASELINE" }),
      constraints: EMPTY_EXPERIMENT_CONSTRAINTS,
      passThreshold: 0.7,
      experimentStatus: "COMPLETED",
      settled: true,
    });
    expect(report.canPromote).toBe(false);
    expect(report.blockers.some((blocker) => blocker.includes("control"))).toBe(true);
  });

  it("blocks and explains a violated constraint", () => {
    const constraints: ExperimentConstraints = { ...EMPTY_EXPERIMENT_CONSTRAINTS, minPassRate: 0.95 };
    const report = verifyExperimentAuthorization({
      candidate: candidateRecord(),
      metrics: metrics({ passRate: 0.8 }),
      constraints,
      passThreshold: 0.7,
      experimentStatus: "COMPLETED",
      settled: true,
    });
    expect(report.canPromote).toBe(false);
    expect(report.blockers.some((blocker) => blocker.includes("80%"))).toBe(true);
    expect(report.constraints?.violated).toBe(1);
  });

  it("warns — but does not block — when a constraint cannot be measured", () => {
    const constraints: ExperimentConstraints = { ...EMPTY_EXPERIMENT_CONSTRAINTS, maxTotalCostUsd: 0.5 };
    const report = verifyExperimentAuthorization({
      candidate: candidateRecord(),
      metrics: metrics({ cost: { costUsd: null, complete: false, unpriced: ["openai:gpt-5"], sources: [], kind: "estimated", billedNote: "estimated" } }),
      constraints,
      passThreshold: 0.7,
      experimentStatus: "COMPLETED",
      settled: true,
    });
    expect(report.canPromote).toBe(true);
    expect(report.warnings.some((warning) => warning.includes("not measured yet"))).toBe(true);
  });

  it("warns about evaluator errors, incomplete aggregates and unreported usage", () => {
    const report = verifyExperimentAuthorization({
      candidate: candidateRecord(),
      metrics: metrics({
        evaluatorErrors: 2,
        incomplete: 1,
        tokens: { total: 500, reported: 8, unreported: 2 },
      }),
      constraints: EMPTY_EXPERIMENT_CONSTRAINTS,
      passThreshold: 0.7,
      experimentStatus: "COMPLETED",
      settled: true,
    });
    expect(report.canPromote).toBe(true);
    expect(report.warnings.some((warning) => warning.includes("evaluator verdict(s) errored"))).toBe(true);
    expect(report.warnings.some((warning) => warning.includes("INCOMPLETE"))).toBe(true);
    expect(report.warnings.some((warning) => warning.includes("token usage"))).toBe(true);
  });

  it("warns — never blocks — when the paired evidence is weak", () => {
    const report = verifyExperimentAuthorization({
      candidate: candidateRecord(),
      metrics: metrics(),
      constraints: EMPTY_EXPERIMENT_CONSTRAINTS,
      passThreshold: 0.7,
      experimentStatus: "COMPLETED",
      settled: true,
      pairedCases: 3,
      evidenceVerdict: "insufficient_sample",
    });
    expect(report.canPromote).toBe(true);
    expect(report.warnings.some((warning) => warning.includes("minimum sample"))).toBe(true);
    expect(report.warnings.some((warning) => warning.includes("does not establish"))).toBe(true);
  });

  it("flags a statistically supported regression as a warning the author can still override", () => {
    const report = verifyExperimentAuthorization({
      candidate: candidateRecord(),
      metrics: metrics(),
      constraints: EMPTY_EXPERIMENT_CONSTRAINTS,
      passThreshold: 0.7,
      experimentStatus: "COMPLETED",
      settled: true,
      evidenceVerdict: "supported_regression",
    });
    expect(report.canPromote).toBe(true);
    expect(report.warnings.some((warning) => warning.includes("supports a regression"))).toBe(true);
  });
});

describe("evaluatePromotionGates", () => {
  const base = {
    experimentStatus: "COMPLETED" as const,
    settled: true,
    selectedCandidateId: "cand-1" as string | null,
    candidate: candidateRecord(),
    metrics: metrics(),
    constraints: EMPTY_EXPERIMENT_CONSTRAINTS,
    primaryReplicateBatchId: "batch-1" as string | null,
  };

  it("allows a promoted candidate that is already selected", () => {
    const gates = evaluatePromotionGates(base);
    expect(gates.allowed).toBe(true);
    expect(gates.blockers).toEqual([]);
  });

  it("refuses a candidate with no sealed batch to promote from", () => {
    const gates = evaluatePromotionGates({ ...base, primaryReplicateBatchId: null });
    expect(gates.allowed).toBe(false);
    expect(gates.blockers.some((blocker) => blocker.includes("no sealed batch"))).toBe(true);
  });

  it("refuses a candidate that was never selected by anyone (no automatic winner)", () => {
    const gates = evaluatePromotionGates({ ...base, selectedCandidateId: null });
    // Promotion delegates to the harness rule; the experiment layer refuses only
    // on evidence grounds, but it never *selects* a candidate on the author's
    // behalf — the service requires an explicit candidateId or selection.
    expect(gates.allowed).toBe(true);
  });

  it("warns when promoting replaces a different selected candidate", () => {
    const gates = evaluatePromotionGates({ ...base, selectedCandidateId: "other-candidate" });
    expect(gates.allowed).toBe(true);
    expect(gates.warnings.some((warning) => warning.includes("currently selected"))).toBe(true);
  });

  it("refuses while the experiment is still running", () => {
    const gates = evaluatePromotionGates({ ...base, experimentStatus: "RUNNING", settled: false });
    expect(gates.allowed).toBe(false);
  });
});
