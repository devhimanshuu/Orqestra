import { describe, expect, it } from "vitest";
import type { BatchMetrics } from "@/modules/evaluation/metrics";
import {
  buildOptimizationHistory,
  classifyEvidence,
  toHistoryFacts,
  type HistorySessionFact,
  type HistorySessionRow,
} from "./history";

/**
 * The history read model is pure, so it is tested directly: rows in, an
 * aggregation out. The cases below pin the rules that make the view honest —
 * category attribution, rates over real denominators, missing-is-not-zero, and
 * evidence that scales with the measured sample.
 */

function metrics(overrides: {
  mean?: number | null;
  passRate?: number | null;
  costUsd?: number | null;
  medianLatencyMs?: number | null;
  total?: number;
}): BatchMetrics {
  return {
    policy: "REQUIRE_ALL",
    cases: {
      total: overrides.total ?? 4,
      completed: overrides.total ?? 4,
      failed: 0,
      skipped: 0,
      cancelled: 0,
      pending: 0,
      running: 0,
    },
    scored: overrides.total ?? 4,
    unscored: 0,
    aggregateStatuses: { complete: overrides.total ?? 4, incomplete: 0, failed: 0 },
    score: { mean: overrides.mean ?? null, median: overrides.mean ?? null },
    passRate: overrides.passRate ?? null,
    passed: 0,
    failed: 0,
    latency: {
      averageMs: overrides.medianLatencyMs ?? null,
      medianMs: overrides.medianLatencyMs ?? null,
      measured: overrides.medianLatencyMs === undefined || overrides.medianLatencyMs === null ? 0 : 4,
    },
    tokens: { total: 0, reported: 0, unreported: 0 },
    cost: {
      costUsd: overrides.costUsd ?? null,
      priced: true,
      pricedModels: [],
      unpricedModels: [],
      unknownCost: overrides.costUsd === undefined || overrides.costUsd === null,
    } as unknown as BatchMetrics["cost"],
    retries: 0,
    toolInvocations: 0,
    perEvaluator: [],
    evaluatorUsage: { llmCalls: 0, llmTokens: 0 } as unknown as BatchMetrics["evaluatorUsage"],
  } as unknown as BatchMetrics;
}

function sessionFact(overrides: Partial<HistorySessionFact> & { id: string }): HistorySessionFact {
  return {
    name: `Session ${overrides.id}`,
    strategy: "RULE_BASED",
    status: "COMPLETED",
    stopReason: "max_iterations",
    primaryMetric: "evaluation_score",
    direction: "maximize",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    completedAt: new Date("2026-01-01T00:10:00.000Z"),
    findings: [],
    hypotheses: [],
    candidates: [],
    ...overrides,
  };
}

describe("classifyEvidence", () => {
  it("scales with the measured sample, never with session count", () => {
    expect(classifyEvidence(0)).toBe("insufficient");
    expect(classifyEvidence(2)).toBe("insufficient");
    expect(classifyEvidence(3)).toBe("suggestive");
    expect(classifyEvidence(7)).toBe("suggestive");
    expect(classifyEvidence(8)).toBe("established");
  });
});

describe("toHistoryFacts", () => {
  it("attributes a candidate to its hypothesis's category and origin, not the session's strategy", () => {
    const rows: HistorySessionRow[] = [
      {
        session: {
          id: "s1",
          name: "Optimize the research agent",
          strategy: "MANUAL",
          status: "COMPLETED",
          stopReason: "max_iterations",
          objective: { primary: { metric: "evaluation_score", direction: "maximize" }, secondary: [], minImprovementPct: 0, notes: null },
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          completedAt: new Date("2026-01-01T00:10:00.000Z"),
        },
        findings: [{ category: "incorrect_final_answer", confidence: "high", isLlm: false }],
        hypotheses: [
          { id: "h1", category: "incorrect_final_answer", origin: "RULE_BASED", status: "SELECTED" },
        ],
        candidates: [
          {
            id: "c1",
            label: "Add a verification step",
            iteration: 1,
            hypothesisId: "h1",
            status: "EVALUATED",
            decisionKind: "ACCEPT",
            metrics: metrics({ mean: 0.6 }),
            baselineMetrics: metrics({ mean: 0.5 }),
            validation: { ok: true, issues: [], nodeCount: 6, edgeCount: 5, entryNode: "start" },
            changeSet: [
              { operation: "insert_node", target: "nodes/verifier", before: null, after: {}, reason: "verify", risk: "MEDIUM" },
            ],
          },
        ],
      },
    ];

    const facts = toHistoryFacts(rows);
    expect(facts[0]?.candidates[0]?.category).toBe("incorrect_final_answer");
    expect(facts[0]?.candidates[0]?.strategy).toBe("RULE_BASED");
    expect(facts[0]?.candidates[0]?.operations).toEqual(["insert_node"]);
    expect(facts[0]?.candidates[0]?.improvement).toBeCloseTo(0.1, 6);
    expect(facts[0]?.candidates[0]?.relativeImprovement).toBeCloseTo(0.2, 6);
  });

  it("treats a minimize metric's improvement in the improving direction", () => {
    const rows: HistorySessionRow[] = [
      {
        session: {
          id: "s1",
          name: "Cheapen the harness",
          strategy: "RULE_BASED",
          status: "COMPLETED",
          stopReason: "max_iterations",
          objective: { primary: { metric: "estimated_cost_usd", direction: "minimize" }, secondary: [], minImprovementPct: 0, notes: null },
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          completedAt: null,
        },
        findings: [],
        hypotheses: [{ id: "h1", category: "excessive_token_usage", origin: "LLM_ASSISTED", status: "SELECTED" }],
        candidates: [
          {
            id: "c1",
            label: "Trim the prompt",
            iteration: 1,
            hypothesisId: "h1",
            status: "EVALUATED",
            decisionKind: "ACCEPT",
            metrics: metrics({ costUsd: 0.08 }),
            baselineMetrics: metrics({ costUsd: 0.1 }),
            validation: null,
            changeSet: [{ operation: "set_prompt", target: "nodes/planner/config/systemPrompt", before: "long", after: "short", reason: "trim", risk: "LOW" }],
          },
        ],
      },
    ];

    const candidate = toHistoryFacts(rows)[0]?.candidates[0];
    expect(candidate?.strategy).toBe("LLM_ASSISTED");
    // Cheaper is better here, so the movement is positive.
    expect(candidate?.improvement).toBeCloseTo(0.02, 6);
    expect(candidate?.relativeImprovement).toBeCloseTo(0.2, 6);
  });

  it("leaves the improvement null when either side was never measured, and the relative delta null at a zero baseline", () => {
    const rows: HistorySessionRow[] = [
      {
        session: {
          id: "s1",
          name: "Unmeasured",
          strategy: "RULE_BASED",
          status: "PARTIALLY_COMPLETED",
          stopReason: "max_runs",
          objective: { primary: { metric: "evaluation_score", direction: "maximize" }, secondary: [], minImprovementPct: 0, notes: null },
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          completedAt: null,
        },
        findings: [],
        hypotheses: [{ id: "h1", category: "incorrect_final_answer", origin: "RULE_BASED", status: "PROPOSED" }],
        candidates: [
          {
            id: "c1",
            label: "Never evaluated",
            iteration: 1,
            hypothesisId: "h1",
            status: "PROPOSED",
            decisionKind: null,
            metrics: null,
            baselineMetrics: metrics({ mean: 0.5 }),
            validation: null,
            changeSet: null,
          },
          {
            id: "c2",
            label: "Zero baseline",
            iteration: 1,
            hypothesisId: "h1",
            status: "EVALUATED",
            decisionKind: "ACCEPT",
            metrics: metrics({ mean: 0.4 }),
            baselineMetrics: metrics({ mean: 0 }),
            validation: null,
            changeSet: null,
          },
        ],
      },
    ];

    const [first, second] = toHistoryFacts(rows)[0]?.candidates ?? [];
    expect(first?.improvement).toBeNull();
    expect(first?.relativeImprovement).toBeNull();
    expect(second?.improvement).toBeCloseTo(0.4, 6);
    // A fraction of zero is not a number, so it is not reported.
    expect(second?.relativeImprovement).toBeNull();
  });

  it("leaves a candidate without a hypothesis unattributed", () => {
    const rows: HistorySessionRow[] = [
      {
        session: {
          id: "s1",
          name: "Manual",
          strategy: "MANUAL",
          status: "COMPLETED",
          stopReason: "max_iterations",
          objective: { primary: { metric: "evaluation_score", direction: "maximize" }, secondary: [], minImprovementPct: 0, notes: null },
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          completedAt: null,
        },
        findings: [],
        hypotheses: [],
        candidates: [
          {
            id: "c1",
            label: "Hand-built",
            iteration: 0,
            hypothesisId: null,
            status: "EVALUATED",
            decisionKind: "ACCEPT",
            metrics: metrics({ mean: 0.7 }),
            baselineMetrics: metrics({ mean: 0.5 }),
            validation: null,
            changeSet: [{ operation: "attach_manual_candidate", target: "harnessVersions.x", before: null, after: "y", reason: "hand built", risk: "MEDIUM" }],
          },
        ],
      },
    ];

    const fact = toHistoryFacts(rows)[0]?.candidates[0];
    expect(fact?.category).toBeNull();
    expect(fact?.strategy).toBe("MANUAL");
  });
});

describe("buildOptimizationHistory", () => {
  it("groups effectiveness by failure category and reports rates over real denominators", () => {
    const sessions: HistorySessionFact[] = [
      sessionFact({
        id: "s1",
        findings: [{ category: "incorrect_final_answer", confidence: "high", isLlm: false }],
        hypotheses: [{ id: "h1", category: "incorrect_final_answer", origin: "RULE_BASED", status: "SELECTED" }],
        candidates: [
          { id: "c1", label: "Verifier", iteration: 1, status: "EVALUATED", decisionKind: "ACCEPT", category: "incorrect_final_answer", strategy: "RULE_BASED", improvement: 0.1, relativeImprovement: 0.2, operations: ["insert_node"] },
          { id: "c2", label: "Restate policy", iteration: 2, status: "EVALUATED", decisionKind: "REJECT", category: "incorrect_final_answer", strategy: "LLM_ASSISTED", improvement: 0, relativeImprovement: 0, operations: ["set_prompt"] },
        ],
      }),
      sessionFact({
        id: "s2",
        findings: [{ category: "incorrect_final_answer", confidence: "medium", isLlm: false }],
        hypotheses: [{ id: "h2", category: "incorrect_final_answer", origin: "RULE_BASED", status: "SELECTED" }],
        candidates: [
          { id: "c3", label: "Critic", iteration: 1, status: "INVALID", decisionKind: "REJECT", category: "incorrect_final_answer", strategy: "RULE_BASED", improvement: null, relativeImprovement: null, operations: ["add_edge"] },
          { id: "c4", label: "Verifier again", iteration: 2, status: "EVALUATED", decisionKind: "ACCEPT", category: "incorrect_final_answer", strategy: "RULE_BASED", improvement: 0.08, relativeImprovement: 0.12, operations: ["insert_node"] },
        ],
      }),
    ];

    const history = buildOptimizationHistory({ sessions, generatedAt: new Date("2026-02-01T00:00:00.000Z") });

    expect(history.totals.sessions).toBe(2);
    expect(history.totals.evaluated).toBe(3);
    expect(history.totals.accepted).toBe(2);
    expect(history.totals.rejected).toBe(2);
    expect(history.totals.invalid).toBe(1);
    expect(history.totals.measuredComparisons).toBe(3);

    const category = history.categories.find((entry) => entry.category === "incorrect_final_answer");
    expect(category).toBeDefined();
    expect(category?.findings).toBe(2);
    expect(category?.sessions).toBe(2);
    expect(category?.hypotheses).toBe(2);
    expect(category?.candidates).toBe(4);
    expect(category?.evaluated).toBe(3);
    // Three evaluated, two accepted.
    expect(category?.acceptanceRate).toBeCloseTo(2 / 3, 6);
    // Measured movements only: unmeasured candidates are not counted as zero.
    expect(category?.measured).toBe(3);
    expect(category?.meanImprovement).toBeCloseTo((0.1 + 0 + 0.08) / 3, 6);

    // Per-strategy effectiveness is separated, and the rule-based arm leads.
    const ruleBased = category?.byStrategy.find((entry) => entry.strategy === "RULE_BASED");
    const llm = category?.byStrategy.find((entry) => entry.strategy === "LLM_ASSISTED");
    expect(ruleBased?.candidates).toBe(3);
    expect(ruleBased?.evaluated).toBe(2);
    expect(ruleBased?.accepted).toBe(2);
    expect(ruleBased?.acceptanceRate).toBeCloseTo(1, 6);
    expect(llm?.candidates).toBe(1);
    expect(llm?.acceptanceRate).toBeCloseTo(0, 6);
    expect(category?.bestStrategy).toBe("RULE_BASED");
  });

  it("reports operations with their own acceptance rates, deterministic and most-used first", () => {
    const sessions: HistorySessionFact[] = [
      sessionFact({
        id: "s1",
        hypotheses: [{ id: "h1", category: "excessive_tool_calls", origin: "RULE_BASED", status: "SELECTED" }],
        candidates: [
          { id: "c1", label: "A", iteration: 1, status: "EVALUATED", decisionKind: "ACCEPT", category: "excessive_tool_calls", strategy: "RULE_BASED", improvement: 0.1, relativeImprovement: 0.1, operations: ["set_prompt", "set_policy"] },
          { id: "c2", label: "B", iteration: 2, status: "EVALUATED", decisionKind: "REJECT", category: "excessive_tool_calls", strategy: "RULE_BASED", improvement: -0.1, relativeImprovement: -0.1, operations: ["set_prompt"] },
        ],
      }),
    ];

    const category = buildOptimizationHistory({ sessions, generatedAt: new Date() }).categories[0];
    expect(category?.operations.map((entry) => entry.operation)).toEqual(["set_prompt", "set_policy"]);
    const setPrompt = category?.operations.find((entry) => entry.operation === "set_prompt");
    expect(setPrompt?.candidates).toBe(2);
    expect(setPrompt?.accepted).toBe(1);
    expect(setPrompt?.acceptanceRate).toBeCloseTo(0.5, 6);
  });

  it("classifies evidence by measured sample and says so in the notes", () => {
    const candidates = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `c${index}`,
        label: `Candidate ${index}`,
        iteration: index,
        status: "EVALUATED" as const,
        decisionKind: "ACCEPT" as const,
        category: "premature_termination" as const,
        strategy: "RULE_BASED" as const,
        improvement: 0.05,
        relativeImprovement: 0.05,
        operations: ["set_policy"],
      }));

    const two = buildOptimizationHistory({
      sessions: [
        sessionFact({
          id: "s1",
          hypotheses: [{ id: "h1", category: "premature_termination", origin: "RULE_BASED", status: "SELECTED" }],
          candidates: candidates(2),
        }),
      ],
      generatedAt: new Date(),
    });
    expect(two.categories[0]?.evidence).toBe("insufficient");
    expect(two.notes.some((note) => note.includes("fewer than 3 measured comparison"))).toBe(true);

    const eight = buildOptimizationHistory({
      sessions: [
        sessionFact({
          id: "s1",
          hypotheses: [{ id: "h1", category: "premature_termination", origin: "RULE_BASED", status: "SELECTED" }],
          candidates: candidates(8),
        }),
      ],
      generatedAt: new Date(),
    });
    expect(eight.categories[0]?.evidence).toBe("established");
  });

  it("keeps candidates that test no hypothesis out of the category table", () => {
    const sessions: HistorySessionFact[] = [
      sessionFact({
        id: "s1",
        hypotheses: [{ id: "h1", category: "incorrect_final_answer", origin: "RULE_BASED", status: "SELECTED" }],
        candidates: [
          { id: "c1", label: "Proposed", iteration: 1, status: "EVALUATED", decisionKind: "ACCEPT", category: "incorrect_final_answer", strategy: "RULE_BASED", improvement: 0.1, relativeImprovement: 0.1, operations: ["insert_node"] },
          { id: "c2", label: "Manual", iteration: 2, status: "EVALUATED", decisionKind: "ACCEPT", category: null, strategy: "MANUAL", improvement: 0.2, relativeImprovement: 0.2, operations: ["attach_manual_candidate"] },
        ],
      }),
    ];

    const history = buildOptimizationHistory({ sessions, generatedAt: new Date() });
    expect(history.categories).toHaveLength(1);
    expect(history.categories[0]?.candidates).toBe(1);
    expect(history.unattributed?.candidates).toBe(1);
    expect(history.unattributed?.accepted).toBe(1);
    // Totals still count every candidate, attributed or not.
    expect(history.totals.candidates).toBe(2);
  });

  it("surfaces a category a session observed even when no candidate was proposed yet", () => {
    const sessions: HistorySessionFact[] = [
      sessionFact({
        id: "s1",
        findings: [{ category: "harness_policy_violation", confidence: "high", isLlm: false }],
        hypotheses: [{ id: "h1", category: "harness_policy_violation", origin: "RULE_BASED", status: "PROPOSED" }],
        candidates: [],
      }),
    ];

    const history = buildOptimizationHistory({ sessions, generatedAt: new Date() });
    const category = history.categories.find((entry) => entry.category === "harness_policy_violation");
    expect(category?.findings).toBe(1);
    expect(category?.hypotheses).toBe(1);
    expect(category?.candidates).toBe(0);
    // Nothing evaluated means no rate — not a zero rate.
    expect(category?.acceptanceRate).toBeNull();
    expect(category?.meanImprovement).toBeNull();
    expect(category?.evidence).toBe("insufficient");
    expect(category?.bestStrategy).toBeNull();
    expect(history.unattributed).toBeNull();
  });

  it("counts model-shaped findings separately and never as measurements", () => {
    const sessions: HistorySessionFact[] = [
      sessionFact({
        id: "s1",
        findings: [
          { category: "incorrect_final_answer", confidence: "high", isLlm: false },
          { category: "inconsistent_trials", confidence: "llm", isLlm: true },
        ],
        candidates: [],
      }),
    ];

    const history = buildOptimizationHistory({ sessions, generatedAt: new Date() });
    expect(history.totals.findings).toBe(2);
    expect(history.totals.llmFindings).toBe(1);
    expect(history.totals.sessionsWithFindings).toBe(1);
    expect(history.notes.some((note) => note.includes("shaped by a model"))).toBe(true);
  });

  it("says there is no history rather than reporting empty rates", () => {
    const history = buildOptimizationHistory({ sessions: [], generatedAt: new Date("2026-03-01T00:00:00.000Z") });
    expect(history.totals.sessions).toBe(0);
    expect(history.categories).toEqual([]);
    expect(history.unattributed).toBeNull();
    expect(history.notes[0]).toContain("No optimization sessions match this scope yet");
    expect(history.generatedAt).toBe("2026-03-01T00:00:00.000Z");
  });

  it("orders categories by how much they have actually been worked on", () => {
    const sessions: HistorySessionFact[] = [
      sessionFact({
        id: "s1",
        hypotheses: [
          { id: "h1", category: "excessive_latency", origin: "RULE_BASED", status: "SELECTED" },
          { id: "h2", category: "incorrect_final_answer", origin: "RULE_BASED", status: "SELECTED" },
        ],
        candidates: [
          { id: "c1", label: "Latency fix", iteration: 1, status: "EVALUATED", decisionKind: "ACCEPT", category: "excessive_latency", strategy: "RULE_BASED", improvement: 1, relativeImprovement: 0.1, operations: [] },
          { id: "c2", label: "Answer fix", iteration: 2, status: "EVALUATED", decisionKind: "ACCEPT", category: "incorrect_final_answer", strategy: "RULE_BASED", improvement: 1, relativeImprovement: 0.1, operations: [] },
          { id: "c3", label: "Answer fix 2", iteration: 3, status: "EVALUATED", decisionKind: "ACCEPT", category: "incorrect_final_answer", strategy: "RULE_BASED", improvement: 1, relativeImprovement: 0.1, operations: [] },
        ],
      }),
    ];

    const history = buildOptimizationHistory({ sessions, generatedAt: new Date() });
    expect(history.categories.map((entry) => entry.category)).toEqual([
      "incorrect_final_answer",
      "excessive_latency",
    ]);
  });

  it("keeps means in one unit when sessions optimize different metrics", () => {
    const sessions: HistorySessionFact[] = [
      sessionFact({
        id: "s1",
        primaryMetric: "evaluation_score",
        hypotheses: [{ id: "h1", category: "incorrect_final_answer", origin: "RULE_BASED", status: "SELECTED" }],
        candidates: [
          { id: "c1", label: "A", iteration: 1, status: "EVALUATED", decisionKind: "ACCEPT", category: "incorrect_final_answer", strategy: "RULE_BASED", improvement: 0.1, relativeImprovement: 0.1, operations: [] },
          { id: "c2", label: "B", iteration: 2, status: "EVALUATED", decisionKind: "ACCEPT", category: "incorrect_final_answer", strategy: "RULE_BASED", improvement: 0.2, relativeImprovement: 0.2, operations: [] },
        ],
      }),
      sessionFact({
        id: "s2",
        // A different objective: this session's deltas are milliseconds, not scores.
        primaryMetric: "median_latency_ms",
        direction: "minimize",
        hypotheses: [{ id: "h2", category: "incorrect_final_answer", origin: "RULE_BASED", status: "SELECTED" }],
        candidates: [
          { id: "c3", label: "C", iteration: 1, status: "EVALUATED", decisionKind: "REJECT", category: "incorrect_final_answer", strategy: "RULE_BASED", improvement: 900, relativeImprovement: 0.9, operations: [] },
        ],
      }),
    ];

    const category = buildOptimizationHistory({ sessions, generatedAt: new Date() }).categories[0];
    expect(category?.mixedMetrics).toBe(true);
    // Two samples on evaluation_score beat one on latency, so that is the unit.
    expect(category?.metric).toBe("evaluation_score");
    expect(category?.measured).toBe(2);
    expect(category?.meanImprovement).toBeCloseTo(0.15, 6);
    // The latency sample is excluded from the mean, and said so.
    expect(category?.measuredExcluded).toBe(1);
    // Every evaluated candidate still counts toward the rate.
    expect(category?.evaluated).toBe(3);
    expect(category?.acceptanceRate).toBeCloseTo(2 / 3, 6);
  });
});
