import { describe, expect, it } from "vitest";
import {
  OptimizationConflictError,
  OPTIMIZATION_STATUSES,
  isTerminalOptimizationStatus,
  type OptimizationStatus,
} from "./optimization.types";
import {
  assertOptimizationTransition,
  canTransitionOptimization,
  describeOptimizationTransition,
  isCancellableOptimizationStatus,
  isResumableOptimizationStatus,
  isStartableOptimizationStatus,
  settleOptimizationStatus,
} from "./optimization.lifecycle";

/**
 * Transitions are declared, not implied. These tests are the declaration: an
 * illegal move must be refused with a reason, a settled session must be
 * permanent, and the status a finished pass settles into must be derived from
 * what actually happened rather than from a flag kept in memory.
 */

describe("canTransitionOptimization", () => {
  it("allows the lifecycle a session is supposed to have", () => {
    expect(canTransitionOptimization("DRAFT", "QUEUED")).toBe(true);
    expect(canTransitionOptimization("QUEUED", "RUNNING")).toBe(true);
    expect(canTransitionOptimization("RUNNING", "WAITING_FOR_REVIEW")).toBe(true);
    expect(canTransitionOptimization("WAITING_FOR_REVIEW", "QUEUED")).toBe(true);
    expect(canTransitionOptimization("RUNNING", "COMPLETED")).toBe(true);
    expect(canTransitionOptimization("RUNNING", "CANCELLED")).toBe(true);
    // A crashed pass goes back through the queue and is claimed atomically.
    expect(canTransitionOptimization("RUNNING", "QUEUED")).toBe(true);
  });

  it("refuses the moves that would contradict the session's own history", () => {
    expect(canTransitionOptimization("DRAFT", "COMPLETED")).toBe(false);
    expect(canTransitionOptimization("DRAFT", "RUNNING")).toBe(false);
    expect(canTransitionOptimization("WAITING_FOR_REVIEW", "RUNNING")).toBe(false);
    for (const terminal of ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED", "CANCELLED"] as const) {
      expect(canTransitionOptimization(terminal, "QUEUED")).toBe(false);
      expect(canTransitionOptimization(terminal, "RUNNING")).toBe(false);
    }
  });

  it("makes every terminal status final for every other status", () => {
    const terminal: OptimizationStatus[] = [
      "COMPLETED",
      "PARTIALLY_COMPLETED",
      "FAILED",
      "CANCELLED",
    ];
    for (const from of OPTIMIZATION_STATUSES) {
      for (const to of terminal) {
        if (isTerminalOptimizationStatus(from)) {
          expect(canTransitionOptimization(from, to)).toBe(false);
        }
      }
    }
  });

  it("asserts with a readable error instead of failing silently", () => {
    expect(() => assertOptimizationTransition("COMPLETED", "QUEUED")).toThrow(OptimizationConflictError);
    expect(() => assertOptimizationTransition("DRAFT", "QUEUED")).not.toThrow();
    expect(() => assertOptimizationTransition("DRAFT", "RUNNING")).toThrow(
      /cannot move from DRAFT to RUNNING/,
    );
    expect(describeOptimizationTransition("DRAFT", "QUEUED")).toBe("optimization DRAFT → QUEUED");
  });
});

describe("status predicates", () => {
  it("treats drafts, queued and parked sessions as startable", () => {
    expect(isStartableOptimizationStatus("DRAFT")).toBe(true);
    expect(isStartableOptimizationStatus("QUEUED")).toBe(true);
    expect(isStartableOptimizationStatus("WAITING_FOR_REVIEW")).toBe(true);
    expect(isStartableOptimizationStatus("RUNNING")).toBe(false);
    expect(isStartableOptimizationStatus("COMPLETED")).toBe(false);
  });

  it("treats only an active session as resumable", () => {
    expect(isResumableOptimizationStatus("RUNNING")).toBe(true);
    expect(isResumableOptimizationStatus("WAITING_FOR_REVIEW")).toBe(true);
    expect(isResumableOptimizationStatus("DRAFT")).toBe(false);
  });

  it("never reports a settled session as cancellable", () => {
    expect(isCancellableOptimizationStatus("DRAFT")).toBe(true);
    expect(isCancellableOptimizationStatus("RUNNING")).toBe(true);
    for (const terminal of ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED", "CANCELLED"] as const) {
      expect(isCancellableOptimizationStatus(terminal)).toBe(false);
    }
  });
});

describe("settleOptimizationStatus", () => {
  it("settles a cancelled pass as cancelled", () => {
    expect(
      settleOptimizationStatus({
        cancelled: true,
        infraFailed: false,
        evaluatedCandidates: 5,
        acceptedCandidates: 2,
        stoppedEarly: false,
      }),
    ).toBe("CANCELLED");
  });

  it("settles an infrastructure failure as failed, whatever else happened", () => {
    expect(
      settleOptimizationStatus({
        cancelled: false,
        infraFailed: true,
        evaluatedCandidates: 5,
        acceptedCandidates: 2,
        stoppedEarly: false,
      }),
    ).toBe("FAILED");
  });

  it("settles a pass that never produced an evaluation as failed", () => {
    expect(
      settleOptimizationStatus({
        cancelled: false,
        infraFailed: false,
        evaluatedCandidates: 0,
        acceptedCandidates: 0,
        stoppedEarly: false,
      }),
    ).toBe("FAILED");
  });

  it("distinguishes a run cut short by a budget from one that ran to completion", () => {
    expect(
      settleOptimizationStatus({
        cancelled: false,
        infraFailed: false,
        evaluatedCandidates: 4,
        acceptedCandidates: 1,
        stoppedEarly: true,
      }),
    ).toBe("PARTIALLY_COMPLETED");
    expect(
      settleOptimizationStatus({
        cancelled: false,
        infraFailed: false,
        evaluatedCandidates: 4,
        acceptedCandidates: 1,
        stoppedEarly: false,
      }),
    ).toBe("COMPLETED");
  });

  it("only returns terminal statuses", () => {
    const terminal = ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED", "CANCELLED"];
    expect(
      terminal,
    ).toContain(
      settleOptimizationStatus({
        cancelled: false,
        infraFailed: false,
        evaluatedCandidates: 1,
        acceptedCandidates: 0,
        stoppedEarly: true,
      }),
    );
  });
});
