/**
 * Session lifecycle.
 *
 * Transitions are declared, not implied: the service validates every status
 * change against this table, so an illegal move (resuming a cancelled session,
 * starting a completed one) is refused with a reason instead of producing a
 * session that contradicts its own history.
 */

import { OptimizationConflictError, isTerminalOptimizationStatus } from "./optimization.types";
import type { OptimizationStatus, TerminalOptimizationStatus } from "./optimization.types";

const TRANSITIONS: Record<OptimizationStatus, readonly OptimizationStatus[]> = {
  DRAFT: ["QUEUED", "CANCELLED"],
  QUEUED: ["RUNNING", "CANCELLED", "FAILED"],
  RUNNING: [
    "WAITING_FOR_REVIEW",
    "COMPLETED",
    "PARTIALLY_COMPLETED",
    "FAILED",
    "CANCELLED",
    // Resuming a crashed pass returns it to the queue; the orchestrator claims it
    // atomically, so this is safe even if the old pass is still alive.
    "QUEUED",
  ],
  WAITING_FOR_REVIEW: ["QUEUED", "CANCELLED", "FAILED", "COMPLETED", "PARTIALLY_COMPLETED"],
  COMPLETED: [],
  PARTIALLY_COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransitionOptimization(from: OptimizationStatus, to: OptimizationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertOptimizationTransition(from: OptimizationStatus, to: OptimizationStatus): void {
  if (!canTransitionOptimization(from, to)) {
    throw new OptimizationConflictError(
      `An optimization session cannot move from ${from} to ${to}.`,
    );
  }
}

export function isStartableOptimizationStatus(status: OptimizationStatus): boolean {
  return status === "DRAFT" || status === "QUEUED" || status === "WAITING_FOR_REVIEW";
}

export function isCancellableOptimizationStatus(status: OptimizationStatus): boolean {
  return !isTerminalOptimizationStatus(status);
}

export function isResumableOptimizationStatus(status: OptimizationStatus): boolean {
  return status === "RUNNING" || status === "WAITING_FOR_REVIEW";
}

/**
 * The status a finished pass settles into, derived from what happened rather
 * than from a flag the worker kept in memory.
 *
 *  - cancelled by request → CANCELLED;
 *  - nothing ran at all → FAILED (the loop never got to try);
 *  - an accepted improvement exists but the run stopped early → PARTIALLY_COMPLETED
 *    only when the loop was cut short; otherwise COMPLETED.
 */
export function settleOptimizationStatus(input: {
  cancelled: boolean;
  infraFailed: boolean;
  evaluatedCandidates: number;
  acceptedCandidates: number;
  stoppedEarly: boolean;
}): TerminalOptimizationStatus {
  if (input.cancelled) {
    return "CANCELLED";
  }
  if (input.infraFailed) {
    return "FAILED";
  }
  if (input.evaluatedCandidates === 0) {
    // The process ran but never produced a usable evaluation: that is a failure
    // of the loop, not a completed optimization.
    return "FAILED";
  }
  if (input.stoppedEarly) {
    return "PARTIALLY_COMPLETED";
  }
  return "COMPLETED";
}

export function describeOptimizationTransition(from: OptimizationStatus, to: OptimizationStatus): string {
  return `optimization ${from} → ${to}`;
}
