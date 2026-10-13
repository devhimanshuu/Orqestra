import { describe, expect, it } from "vitest";
import {
  canTransitionExperiment,
  assertExperimentTransition,
  settleExperimentStatus,
  isLaunchableExperimentStatus,
  isCancellableExperimentStatus,
  isPausableExperimentStatus,
  isResumableExperimentStatus,
  EXPERIMENT_TRANSITIONS,
} from "./experiment.lifecycle";
import { ExperimentConflictError, EXPERIMENT_STATUSES } from "./experiment.types";

/**
 * The state machine is the part of an experiment that must never be wrong:
 * a bad transition is how a cancelled experiment starts running again, or a
 * finished one silently re-opens. Every legal and illegal edge is asserted here.
 */

describe("experiment transitions", () => {
  it("allows the documented transitions", () => {
    const legal: Array<[string, string]> = [
      ["DRAFT", "QUEUED"],
      ["DRAFT", "CANCELLED"],
      ["QUEUED", "RUNNING"],
      ["QUEUED", "PAUSED"],
      ["RUNNING", "PAUSED"],
      ["RUNNING", "COMPLETED"],
      ["RUNNING", "PARTIALLY_COMPLETED"],
      ["RUNNING", "FAILED"],
      ["RUNNING", "CANCELLED"],
      ["PAUSED", "QUEUED"],
      ["PAUSED", "RUNNING"],
      ["PAUSED", "CANCELLED"],
    ];
    for (const [from, to] of legal) {
      expect(canTransitionExperiment(from as never, to as never), `${from} → ${to}`).toBe(true);
    }
  });

  it("refuses to reopen a terminal experiment", () => {
    const terminal = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED", "CANCELLED"] as const;
    for (const from of terminal) {
      for (const to of EXPERIMENT_STATUSES) {
        if (to === from) {
          continue;
        }
        expect(canTransitionExperiment(from, to), `${from} → ${to}`).toBe(false);
      }
    }
  });

  it("refuses DRAFT → RUNNING (an experiment must be queued first)", () => {
    expect(canTransitionExperiment("DRAFT", "RUNNING")).toBe(false);
    expect(() => assertExperimentTransition("DRAFT", "RUNNING")).toThrow(ExperimentConflictError);
  });

  it("treats a no-op transition as legal (idempotent settle)", () => {
    for (const status of EXPERIMENT_STATUSES) {
      expect(canTransitionExperiment(status, status)).toBe(true);
    }
  });

  it("documents the same edges it allows", () => {
    for (const status of EXPERIMENT_STATUSES) {
      for (const target of EXPERIMENT_TRANSITIONS[status]) {
        expect(canTransitionExperiment(status, target)).toBe(true);
      }
    }
  });
});

describe("status helpers", () => {
  it("only a draft is launchable", () => {
    expect(isLaunchableExperimentStatus("DRAFT")).toBe(true);
    for (const status of EXPERIMENT_STATUSES.filter((entry) => entry !== "DRAFT")) {
      expect(isLaunchableExperimentStatus(status)).toBe(false);
    }
  });

  it("cancellation is possible until the experiment settles", () => {
    expect(isCancellableExperimentStatus("RUNNING")).toBe(true);
    expect(isCancellableExperimentStatus("PAUSED")).toBe(true);
    expect(isCancellableExperimentStatus("COMPLETED")).toBe(false);
    expect(isCancellableExperimentStatus("CANCELLED")).toBe(false);
  });

  it("only an in-flight experiment can pause, and only a paused one can resume", () => {
    expect(isPausableExperimentStatus("QUEUED")).toBe(true);
    expect(isPausableExperimentStatus("PAUSED")).toBe(false);
    expect(isResumableExperimentStatus("PAUSED")).toBe(true);
    expect(isResumableExperimentStatus("RUNNING")).toBe(false);
  });
});

describe("settleExperimentStatus", () => {
  const base = {
    completed: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    pending: 0,
    running: 0,
    cancelledByRequest: false,
    budgetStop: false,
  };

  it("stays running while executions are outstanding", () => {
    expect(settleExperimentStatus({ ...base, completed: 5, running: 1 })).toBe("RUNNING");
    expect(settleExperimentStatus({ ...base, completed: 5, pending: 3 })).toBe("RUNNING");
  });

  it("is CANCELLED when cancellation was requested, even with work outstanding", () => {
    expect(
      settleExperimentStatus({ ...base, completed: 2, running: 1, cancelledByRequest: true }),
    ).toBe("CANCELLED");
  });

  it("is CANCELLED when everything was cancelled", () => {
    expect(settleExperimentStatus({ ...base, cancelled: 8, cancelledByRequest: true })).toBe("CANCELLED");
  });

  it("is COMPLETED when every execution completed", () => {
    expect(settleExperimentStatus({ ...base, completed: 12 })).toBe("COMPLETED");
  });

  it("is PARTIALLY_COMPLETED when some cases ran and some failed", () => {
    expect(settleExperimentStatus({ ...base, completed: 9, failed: 3 })).toBe("PARTIALLY_COMPLETED");
  });

  it("is FAILED when nothing produced a result", () => {
    expect(settleExperimentStatus({ ...base, failed: 4 })).toBe("FAILED");
    expect(settleExperimentStatus({ ...base, skipped: 4 })).toBe("FAILED");
    expect(settleExperimentStatus({ ...base })).toBe("FAILED");
  });

  it("stops on a budget as partially completed, not as a success", () => {
    expect(settleExperimentStatus({ ...base, completed: 6, budgetStop: true })).toBe("PARTIALLY_COMPLETED");
    expect(settleExperimentStatus({ ...base, budgetStop: true })).toBe("FAILED");
  });

  it("reports partial completion when only some cases were cancelled", () => {
    expect(settleExperimentStatus({ ...base, completed: 7, cancelled: 5 })).toBe("PARTIALLY_COMPLETED");
  });
});
