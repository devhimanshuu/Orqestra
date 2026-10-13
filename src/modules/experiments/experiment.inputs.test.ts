import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  MAX_EXPERIMENT_CANDIDATES,
  MAX_EXPERIMENT_CASES,
  createExperimentSchema,
  launchExperimentSchema,
  listExperimentsQuerySchema,
  promoteCandidateSchema,
  updateExperimentSchema,
} from "./experiment.inputs";

/**
 * The input contracts are the API's first line of defence: a request that cannot
 * be run safely is refused before anything is sealed or scheduled. These tests
 * pin the ceilings and the defaults the wizard relies on.
 */

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    projectId: "project-1",
    agentId: "agent-1",
    name: "Critic loop vs single-pass",
    baseline: { harnessVersionId: "hv-base" },
    candidates: [{ harnessVersionId: "hv-cand" }],
    datasetId: "dataset-1",
    evaluators: [{ evaluatorId: "ev-1" }],
    ...overrides,
  };
}

describe("createExperimentSchema", () => {
  it("accepts a minimal configuration and applies candidate defaults", () => {
    const parsed = createExperimentSchema.parse(validBody());
    expect(parsed.candidates).toHaveLength(1);
    // Execution settings are optional at the API boundary: the service fills in
    // the platform defaults and clamps them before anything is sealed.
    expect(parsed.execution).toBeUndefined();
    expect(parsed.scoringPolicy).toBeUndefined();
    expect(parsed.passThreshold).toBeUndefined();
  });

  it("fills the documented defaults into a partially specified execution block", () => {
    const parsed = createExperimentSchema.parse(validBody({ execution: { concurrency: 3 } }));
    expect(parsed.execution?.concurrency).toBe(3);
    expect(parsed.execution?.replicates).toBe(1);
    expect(parsed.execution?.ordering).toBe("interleaved");
    expect(parsed.execution?.retryPolicy.maxAttempts).toBe(2);
    expect(parsed.execution?.budget).toEqual({
      maxRuns: null,
      maxTotalTokens: null,
      maxCostUsd: null,
    });
    expect(parsed.execution?.caseSelection).toEqual({ tags: [], caseKeys: [], limit: null });
  });

  it("requires at least one candidate to compare against the baseline", () => {
    expect(() => createExperimentSchema.parse(validBody({ candidates: [] }))).toThrow(z.ZodError);
  });

  it("requires at least one evaluator", () => {
    expect(() => createExperimentSchema.parse(validBody({ evaluators: [] }))).toThrow(z.ZodError);
  });

  it("requires a name and a dataset", () => {
    expect(() => createExperimentSchema.parse(validBody({ name: "" }))).toThrow(z.ZodError);
    expect(() => createExperimentSchema.parse(validBody({ datasetId: "" }))).toThrow(z.ZodError);
  });

  it("refuses more candidates than the platform ceiling allows", () => {
    const candidates = Array.from({ length: MAX_EXPERIMENT_CANDIDATES }, (_, index) => ({
      harnessVersionId: `hv-${index}`,
    }));
    expect(() => createExperimentSchema.parse(validBody({ candidates }))).toThrow(z.ZodError);
  });

  it("rejects an unknown objective metric", () => {
    expect(() =>
      createExperimentSchema.parse(
        validBody({ objective: { primary: { metric: "vibes", direction: "maximize" } } }),
      ),
    ).toThrow(z.ZodError);
  });

  it("rejects an out-of-range constraint", () => {
    expect(() =>
      createExperimentSchema.parse(validBody({ constraints: { minPassRate: 4 } })),
    ).toThrow(z.ZodError);
  });

  it("rejects execution settings beyond the platform ceilings", () => {
    expect(() =>
      createExperimentSchema.parse(validBody({ execution: { concurrency: 99 } })),
    ).toThrow(z.ZodError);
    expect(() =>
      createExperimentSchema.parse(validBody({ execution: { replicates: 99 } })),
    ).toThrow(z.ZodError);
    expect(() =>
      createExperimentSchema.parse(
        validBody({ execution: { caseSelection: { limit: MAX_EXPERIMENT_CASES + 1 } } }),
      ),
    ).toThrow(z.ZodError);
    expect(() =>
      createExperimentSchema.parse(validBody({ execution: { retryPolicy: { maxAttempts: 9 } } })),
    ).toThrow(z.ZodError);
  });
});

describe("updateExperimentSchema", () => {
  it("accepts a partial update and omits the project", () => {
    const parsed = updateExperimentSchema.parse({ name: "Renamed" });
    expect(parsed.name).toBe("Renamed");
    expect("projectId" in parsed).toBe(false);
  });

  it("accepts an empty update (nothing changes)", () => {
    expect(updateExperimentSchema.parse({})).toEqual({});
  });
});

describe("launchExperimentSchema", () => {
  it("refuses a launch that was not explicitly confirmed", () => {
    expect(() => launchExperimentSchema.parse({})).toThrow(z.ZodError);
    expect(() => launchExperimentSchema.parse({ confirm: false })).toThrow(z.ZodError);
  });

  it("accepts an explicit confirmation", () => {
    expect(launchExperimentSchema.parse({ confirm: true })).toEqual({ confirm: true });
  });
});

describe("listExperimentsQuerySchema", () => {
  it("parses a comma-separated status filter into uppercase statuses", () => {
    const parsed = listExperimentsQuerySchema.parse({ status: "running, paused" });
    expect(parsed.status).toEqual(["RUNNING", "PAUSED"]);
  });

  it("drops unknown statuses instead of failing the request", () => {
    const parsed = listExperimentsQuerySchema.parse({ status: "RUNNING,NOPE" });
    expect(parsed.status).toEqual(["RUNNING"]);
  });

  it("treats an empty status as no filter", () => {
    expect(listExperimentsQuerySchema.parse({ status: "" }).status).toBeUndefined();
  });

  it("defaults the sort to newest first", () => {
    const parsed = listExperimentsQuerySchema.parse({});
    expect(parsed.sort).toBe("createdAt");
    expect(parsed.order).toBe("desc");
  });
});

describe("promoteCandidateSchema", () => {
  it("defaults to the already selected candidate", () => {
    expect(promoteCandidateSchema.parse({})).toEqual({ candidateId: undefined, passRateThreshold: undefined, notes: undefined });
  });

  it("rejects a pass-rate threshold outside 0…1", () => {
    expect(() => promoteCandidateSchema.parse({ passRateThreshold: 2 })).toThrow(z.ZodError);
  });
});
