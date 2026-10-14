import { describe, expect, it } from "vitest";
import type { BatchMetrics } from "@/modules/evaluation/metrics";
import {
  verifyOptimizationPromotion,
  verifyOptimizationReview,
} from "./optimization.authorization";
import type {
  AcceptanceDecision,
  OptimizationCandidateRecord,
  OptimizationCandidateStatus,
} from "./optimization.types";

/** The slice of a candidate's measured metrics the promotion rules read. */
function measured(input: { scoreMean: number }): BatchMetrics {
  return {
    policy: "REQUIRE_ALL",
    cases: {
      total: 3,
      completed: 3,
      failed: 0,
      skipped: 0,
      cancelled: 0,
      pending: 0,
      running: 0,
    },
    scored: 3,
    unscored: 0,
    aggregateStatuses: { complete: 3, incomplete: 0, failed: 0 },
    score: { mean: input.scoreMean, median: input.scoreMean },
    passRate: 1,
    passed: 3,
    failed: 0,
    latency: { averageMs: 100, medianMs: 100, measured: 3 },
    tokens: { total: 300, reported: 3, unreported: 0 },
    cost: {
      costUsd: 0.1,
      complete: true,
      unpriced: [],
      sources: ["test"],
      kind: "estimated",
      billedNote: "estimated",
    },
    retries: 0,
    toolInvocations: 0,
    perEvaluator: [],
    evaluatorUsage: {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      unknownCost: false,
    },
  };
}

/**
 * Review and promotion are the two decisions a human makes for the loop, so the
 * rules are pinned here rather than left in the service:
 *
 *  - a candidate can only be approved when the session is parked, its graph is
 *    valid, and its exact definition is stored (otherwise approval could not be
 *    resumed after a restart);
 *  - promotion needs a settled session, a measured candidate, a published
 *    version and a sealed batch;
 *  - a rejection or a violated hard constraint blocks promotion;
 *  - an override converts a blocker into a warning, but only with a reason, and
 *    never when there is no artifact to promote at all.
 */

function decision(overrides: Partial<AcceptanceDecision> = {}): AcceptanceDecision {
  return {
    kind: "ACCEPT",
    reasons: ["evaluation_score improved from 0.4 to 0.6 (maximize)."],
    violations: [],
    deltas: [],
    evidenceCompleteness: "complete",
    evidenceStrength: "indicative",
    scoredCases: 3,
    evaluatedAt: "2026-10-13T00:00:00.000Z",
    ...overrides,
  };
}

function candidate(
  overrides: Partial<OptimizationCandidateRecord> = {},
): OptimizationCandidateRecord {
  return {
    id: "cand-1",
    sessionId: "session-1",
    iteration: 1,
    hypothesisId: "hyp-1",
    label: "Add a verification step (i1)",
    draftId: null,
    versionId: null,
    contentHash: null,
    status: "PROPOSED" as OptimizationCandidateStatus,
    validation: { ok: true, issues: [], nodeCount: 5, edgeCount: 4, entryNode: "start" },
    changeSet: [
      {
        operation: "insert_node",
        target: "nodes.critic-1",
        before: null,
        after: "critic",
        reason: "verification",
        risk: "MEDIUM",
      },
    ],
    pendingDefinition: { nodes: [], edges: [] },
    baselineMetrics: null,
    metrics: null,
    evaluationBatchId: null,
    decision: null,
    decisionKind: null,
    fingerprint: "fp-1",
    analyzerTokenUsage: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

describe("verifyOptimizationReview", () => {
  it("approves a valid, parked, unevaluated candidate that carries its definition", () => {
    const report = verifyOptimizationReview({
      sessionStatus: "WAITING_FOR_REVIEW",
      candidate: candidate(),
    });
    expect(report.canApprove).toBe(true);
    expect(report.blockers).toHaveLength(0);
    expect(report.hasDefinition).toBe(true);
    expect(report.checks.every((check) => check.status !== "blocked")).toBe(true);
  });

  it("refuses approval outside a parked session", () => {
    const report = verifyOptimizationReview({ sessionStatus: "RUNNING", candidate: candidate() });
    expect(report.canApprove).toBe(false);
    expect(report.blockers[0]).toContain("running");
  });

  it("refuses approval for a candidate that failed validation", () => {
    const report = verifyOptimizationReview({
      sessionStatus: "WAITING_FOR_REVIEW",
      candidate: candidate({
        validation: {
          ok: false,
          issues: [{ code: "UNREACHABLE_NODE", message: "Node \"orphan\" is unreachable." }],
          nodeCount: 5,
          edgeCount: 4,
          entryNode: "start",
        },
      }),
    });
    expect(report.canApprove).toBe(false);
    expect(report.blockers.join(" ")).toContain("failed validation");
  });

  it("refuses approval when the definition a resumed pass would publish is missing", () => {
    const report = verifyOptimizationReview({
      sessionStatus: "WAITING_FOR_REVIEW",
      candidate: candidate({ pendingDefinition: null }),
    });
    expect(report.canApprove).toBe(false);
    expect(report.hasDefinition).toBe(false);
    expect(report.blockers.join(" ")).toContain("no definition to publish");
  });

  it("refuses approval for a candidate that has already been evaluated", () => {
    const report = verifyOptimizationReview({
      sessionStatus: "WAITING_FOR_REVIEW",
      candidate: candidate({ status: "EVALUATED", versionId: "hv-2", evaluationBatchId: "batch-1" }),
    });
    expect(report.canApprove).toBe(false);
    expect(report.blockers.join(" ")).toContain("already been evaluated");
  });

  it("flags a high-risk change as a warning rather than a blocker", () => {
    const report = verifyOptimizationReview({
      sessionStatus: "WAITING_FOR_REVIEW",
      candidate: candidate({
        changeSet: [
          {
            operation: "remove_node",
            target: "nodes.drafter",
            before: { type: "model" },
            after: null,
            reason: "demo",
            risk: "HIGH",
          },
        ],
      }),
    });
    expect(report.canApprove).toBe(true);
    expect(report.checks.some((check) => check.status === "warning")).toBe(true);
  });
});

describe("verifyOptimizationPromotion", () => {
  const base = {
    sessionStatus: "COMPLETED" as const,
    candidate: candidate({
      status: "EVALUATED",
      metrics: measured({ scoreMean: 0.6 }),
      decision: decision(),
      decisionKind: "ACCEPT" as const,
      evaluationBatchId: "batch-1",
      versionId: "hv-2",
    }),
    override: false,
    overrideReason: null,
  };

  it("promotes an accepted candidate from a settled session", () => {
    const report = verifyOptimizationPromotion(base);
    expect(report.allowed).toBe(true);
    expect(report.blockers).toHaveLength(0);
    expect(report.checks.every((check) => check.status !== "blocked")).toBe(true);
  });

  it("blocks promotion while the session is still running", () => {
    const report = verifyOptimizationPromotion({ ...base, sessionStatus: "RUNNING" });
    expect(report.allowed).toBe(false);
    expect(report.blockers.join(" ")).toContain("settled session");
  });

  it("blocks promotion of a candidate with no measurement", () => {
    const report = verifyOptimizationPromotion({
      ...base,
      candidate: candidate({ status: "EVALUATED", metrics: null, decision: null, decisionKind: null }),
    });
    expect(report.allowed).toBe(false);
    expect(report.blockers.join(" ")).toContain("no measured evaluation");
  });

  it("blocks promotion when the acceptance policy rejected the candidate", () => {
    const report = verifyOptimizationPromotion({
      ...base,
      candidate: candidate({
        status: "EVALUATED",
        metrics: measured({ scoreMean: 0.4 }),
        decision: decision({ kind: "REJECT", reasons: ["did not improve"] }),
        decisionKind: "REJECT",
        evaluationBatchId: "batch-1",
        versionId: "hv-2",
      }),
    });
    expect(report.allowed).toBe(false);
    expect(report.blockers.join(" ")).toContain("rejected this candidate");
  });

  it("blocks promotion across a violated hard constraint", () => {
    const report = verifyOptimizationPromotion({
      ...base,
      candidate: candidate({
        status: "EVALUATED",
        metrics: measured({ scoreMean: 0.4 }),
        decision: decision({
          kind: "ACCEPT",
          violations: [
            { constraint: "max_cost_increase_pct", message: "cost rose", observed: 1, limit: 0.2 },
          ],
        }),
        decisionKind: "ACCEPT",
        evaluationBatchId: "batch-1",
        versionId: "hv-2",
      }),
    });
    expect(report.allowed).toBe(false);
    expect(report.blockers.join(" ")).toContain("max_cost_increase_pct");
  });

  it("warns, but does not block, on an inconclusive or indicative verdict", () => {
    const report = verifyOptimizationPromotion({
      ...base,
      candidate: candidate({
        status: "EVALUATED",
        metrics: measured({ scoreMean: 0.5 }),
        decision: decision({
          kind: "INCONCLUSIVE",
          reasons: ["Evidence was inconclusive."],
          evidenceStrength: "indicative",
        }),
        decisionKind: "INCONCLUSIVE",
        evaluationBatchId: "batch-1",
        versionId: "hv-2",
      }),
    });
    expect(report.allowed).toBe(true);
    expect(report.warnings.join(" ")).toContain("inconclusive");
    expect(report.warnings.join(" ")).toContain("indicative");
  });

  it("converts blockers into warnings when a human overrides with a reason", () => {
    const report = verifyOptimizationPromotion({
      ...base,
      sessionStatus: "RUNNING",
      override: true,
      overrideReason: "Known trade-off, reviewed by the owner.",
    });
    expect(report.allowed).toBe(true);
    expect(report.blockers).toHaveLength(0);
    expect(report.warnings.some((warning) => warning.startsWith("Override accepted:"))).toBe(true);
    expect(report.checks.some((check) => check.label === "Override")).toBe(true);
  });

  it("demands a reason for an override", () => {
    const report = verifyOptimizationPromotion({
      ...base,
      sessionStatus: "RUNNING",
      override: true,
      overrideReason: null,
    });
    expect(report.allowed).toBe(false);
    expect(report.blockers.join(" ")).toContain("must carry a reason");
  });

  it("never lets an override promote something that does not exist", () => {
    const report = verifyOptimizationPromotion({
      ...base,
      candidate: candidate({
        status: "INVALID",
        versionId: null,
        metrics: null,
        evaluationBatchId: null,
        decision: null,
        decisionKind: null,
      }),
      override: true,
      overrideReason: "I insist.",
    });
    expect(report.allowed).toBe(false);
    expect(report.blockers.length).toBeGreaterThan(0);
  });
});
