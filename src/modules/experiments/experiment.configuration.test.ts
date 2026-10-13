import { describe, expect, it } from "vitest";
import {
  buildSchedule,
  clampExecution,
  draftConfigFromRecord,
  normalizeDraftConfiguration,
} from "./experiment.configuration";
import {
  MAX_EXPERIMENT_CASES,
  MAX_EXPERIMENT_CONCURRENCY,
  MAX_EXPERIMENT_REPLICATES,
} from "./experiment.inputs";
import {
  EMPTY_EXPERIMENT_CONSTRAINTS,
  type ExperimentConstraints,
  type ExperimentExecution,
  type ExperimentRecord,
} from "./experiment.types";

/**
 * Scheduling and clamping are the two pieces of launch-time behaviour that must be
 * reproducible: the same configuration must always produce the same execution
 * order, and a client's numbers must never exceed the platform ceilings.
 */

const cases = ["a", "b", "c"].map((caseKey, index) => ({ caseKey, index }));
const candidates = [{ id: "base" }, { id: "cand" }];

function execution(overrides: Partial<ExperimentExecution> = {}): ExperimentExecution {
  return {
    concurrency: 1,
    ordering: "interleaved",
    randomSeed: null,
    replicates: 1,
    caseSelection: { tags: [], caseKeys: [], limit: null },
    timeoutMs: null,
    limits: null,
    retryPolicy: { maxAttempts: 2 },
    budget: { maxRuns: null, maxTotalTokens: null, maxCostUsd: null },
    ...overrides,
  };
}

describe("buildSchedule", () => {
  it("executes every candidate of a case before moving on (interleaved)", () => {
    const schedule = buildSchedule({ candidates, cases, ordering: "interleaved", randomSeed: null, replicates: 1 });
    expect(schedule.map((entry) => entry.candidateIndex)).toEqual([0, 1, 0, 1, 0, 1]);
    expect(schedule.map((entry) => entry.caseKey)).toEqual(["a", "a", "b", "b", "c", "c"]);
    expect(schedule.map((entry) => entry.orderIndex)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("runs the baseline first when asked, so drift cannot hide a candidate's cost", () => {
    const schedule = buildSchedule({
      candidates,
      cases,
      ordering: "baseline_first",
      randomSeed: null,
      replicates: 1,
    });
    expect(schedule.slice(0, 3).every((entry) => entry.candidateIndex === 0)).toBe(true);
    expect(schedule.slice(3, 6).every((entry) => entry.candidateIndex === 1)).toBe(true);
  });

  it("covers every (candidate, case, replicate) exactly once", () => {
    const schedule = buildSchedule({ candidates, cases, ordering: "interleaved", randomSeed: null, replicates: 3 });
    expect(schedule).toHaveLength(2 * 3 * 3);
    const seen = new Set(
      schedule.map((entry) => `${entry.candidateIndex}:${entry.caseKey}:${entry.replicate}`),
    );
    expect(seen.size).toBe(schedule.length);
    expect(schedule.every((entry, index) => entry.orderIndex === index)).toBe(true);
  });

  it("reproduces the same randomized order for the same seed", () => {
    const first = buildSchedule({ candidates, cases: [...cases], ordering: "random", randomSeed: 42, replicates: 1 });
    const second = buildSchedule({ candidates, cases: [...cases], ordering: "random", randomSeed: 42, replicates: 1 });
    expect(first.map((entry) => `${entry.candidateIndex}:${entry.caseKey}`)).toEqual(
      second.map((entry) => `${entry.candidateIndex}:${entry.caseKey}`),
    );
  });

  it("reorders cases for a random schedule while keeping the same work", () => {
    const interleaved = buildSchedule({ candidates, cases: [...cases], ordering: "interleaved", randomSeed: null, replicates: 1 });
    const random = buildSchedule({ candidates, cases: [...cases], ordering: "random", randomSeed: 7, replicates: 1 });
    const same = new Set(random.map((entry) => `${entry.candidateIndex}:${entry.caseKey}`));
    expect(same.size).toBe(interleaved.length);
  });

  it("keeps the original case index so a result can be traced to its dataset case", () => {
    const schedule = buildSchedule({ candidates, cases, ordering: "random", randomSeed: 9, replicates: 1 });
    for (const entry of schedule) {
      expect(entry.index).toBe(cases.find((sample) => sample.caseKey === entry.caseKey)?.index);
    }
  });
});

describe("clampExecution", () => {
  it("clamps concurrency and replicates to the platform ceilings", () => {
    const clamped = clampExecution(
      execution({ concurrency: 50, replicates: 99, caseSelection: { tags: [], caseKeys: [], limit: 5_000 } }),
    );
    expect(clamped.concurrency).toBe(MAX_EXPERIMENT_CONCURRENCY);
    expect(clamped.replicates).toBe(MAX_EXPERIMENT_REPLICATES);
    expect(clamped.caseSelection.limit).toBe(MAX_EXPERIMENT_CASES);
  });

  it("leaves a valid configuration untouched", () => {
    const valid = execution({ concurrency: 3, replicates: 2, caseSelection: { tags: ["hard"], caseKeys: [], limit: 10 } });
    expect(clampExecution(valid)).toEqual(valid);
  });

  it("never invents a limit that was not configured", () => {
    expect(clampExecution(execution()).caseSelection.limit).toBeNull();
  });
});

describe("normalizeDraftConfiguration", () => {
  it("fills in the platform defaults for an empty configuration", () => {
    const normalized = normalizeDraftConfiguration({});
    expect(normalized.objective.primary.metric).toBe("evaluation_score");
    expect(normalized.objective.primary.direction).toBe("maximize");
    expect(normalized.constraints).toEqual(EMPTY_EXPERIMENT_CONSTRAINTS);
    expect(normalized.execution.ordering).toBe("interleaved");
    expect(normalized.execution.retryPolicy.maxAttempts).toBe(2);
  });

  it("keeps the caller's objective and constraints", () => {
    const objective = {
      primary: { metric: "median_latency_ms" as const, direction: "minimize" as const },
      secondary: [{ metric: "evaluation_score" as const, direction: "maximize" as const }],
      notes: "Cheaper answers matter.",
    };
    const constraints: ExperimentConstraints = {
      ...EMPTY_EXPERIMENT_CONSTRAINTS,
      minPassRate: 0.8,
      maxTotalCostUsd: 2,
    };
    const normalized = normalizeDraftConfiguration({ objective, constraints });
    expect(normalized.objective).toEqual(objective);
    expect(normalized.constraints).toEqual(constraints);
  });

  it("deep-merges execution settings so a partial override keeps the defaults", () => {
    const normalized = normalizeDraftConfiguration({
      execution: { concurrency: 3, budget: { maxRuns: 10, maxTotalTokens: null, maxCostUsd: null } },
    });
    expect(normalized.execution.concurrency).toBe(3);
    expect(normalized.execution.ordering).toBe("interleaved");
    expect(normalized.execution.budget.maxRuns).toBe(10);
    expect(normalized.execution.budget.maxCostUsd).toBeNull();
  });
});

// -----------------------------------------------------------------------------

/**
 * A stored draft must round-trip without its original request body: pre-flight,
 * edit and seal all re-read the pinned candidate rows written at creation. The
 * empty-baseline case documents why those rows must exist — resolution on `""`
 * fails loudly instead of silently picking some version.
 */
describe("draftConfigFromRecord", () => {
  const pinnedRows = [
    {
      harnessVersionId: "hv-cand",
      label: "Critic added",
      hypothesis: "Compliance passes with a critic",
      role: "CANDIDATE",
    },
    {
      harnessVersionId: "hv-base",
      label: "Baseline (lean v1)",
      hypothesis: null,
      role: "BASELINE",
    },
  ];

  function draftRecord(): ExperimentRecord {
    return {
      id: "exp-1",
      projectId: "project-1",
      agentId: "agent-1",
      name: "Critic loop vs single-pass",
      description: null,
      hypothesis: null,
      status: "DRAFT",
      datasetId: "dataset-1",
      datasetVersionId: "dsv-1",
      datasetSnapshot: [],
      evaluatorConfig: [
        {
          key: "ev-1@3",
          evaluatorId: "ev-1",
          evaluatorVersion: 3,
          kind: "exact_match",
          name: "Exact match",
          weight: 1,
          config: {},
          usesLlm: false,
        },
      ],
      scoringPolicy: "REQUIRE_ALL",
      passThreshold: 0.75,
      objective: {
        primary: { metric: "evaluation_score", direction: "maximize" },
        secondary: [],
        notes: null,
      },
      constraints: EMPTY_EXPERIMENT_CONSTRAINTS,
      execution: execution(),
      configSnapshot: null,
      caseCount: 3,
      plannedRunCount: 6,
      metrics: null,
      selectedCandidateId: null,
      selectionKind: null,
      selectionNotes: null,
      selectedBy: null,
      selectedAt: null,
      promotedCandidateId: null,
      promotionNotes: null,
      promotedBy: null,
      promotedAt: null,
      cancelRequestedAt: null,
      pausedAt: null,
      startedAt: null,
      completedAt: null,
      createdBy: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
  }

  it("recovers the baseline by role and the challengers by elimination", () => {
    const config = draftConfigFromRecord(draftRecord(), pinnedRows);
    expect(config.baseline).toEqual({
      harnessVersionId: "hv-base",
      label: "Baseline (lean v1)",
      hypothesis: null,
    });
    expect(config.candidates).toEqual([
      {
        harnessVersionId: "hv-cand",
        label: "Critic added",
        hypothesis: "Compliance passes with a critic",
      },
    ]);
  });

  it("recovers the evaluator pins from the stored snapshot keys", () => {
    const config = draftConfigFromRecord(draftRecord(), pinnedRows);
    expect(config.evaluators).toEqual([{ evaluatorId: "ev-1", weight: 1 }]);
    expect(config.datasetVersionId).toBe("dsv-1");
    expect(config.datasetId).toBe("dataset-1");
  });

  it("cannot resolve a draft whose candidate rows were never written", () => {
    const config = draftConfigFromRecord(draftRecord(), []);
    // The empty harness version id is what makes resolution fail loudly —
    // drafts persist their pins as rows at creation so this never happens.
    expect(config.baseline.harnessVersionId).toBe("");
    expect(config.candidates).toEqual([]);
  });
});
