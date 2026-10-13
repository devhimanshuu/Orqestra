/**
 * The experiment state machine.
 *
 * One place decides which status changes are legal, so an API call, a worker
 * restart or a resumed job cannot put an experiment into a state that contradicts
 * its own records.
 *
 *   DRAFT ──launch──► QUEUED ──worker──► RUNNING ──settle──► COMPLETED
 *                       ▲                  │  │                 PARTIALLY_COMPLETED
 *                       │                  │  └──cancel─────► CANCELLED
 *                       │                  └──pause──► PAUSED ──resume──► QUEUED
 *                       └── resume ────────┘                     │
 *                                                                 └──cancel──► CANCELLED
 *
 * Terminal states (COMPLETED, PARTIALLY_COMPLETED, FAILED, CANCELLED) are final:
 * a finished experiment is evidence, so nothing may quietly reopen it. Re-running
 * means creating a new experiment.
 *
 * Pause and resume semantics, stated exactly:
 *
 *   pause   — sets `pausedAt` durably and moves the experiment to PAUSED. The
 *             orchestrator stops *scheduling* new cases; cases already in flight
 *             are allowed to finish (a run cannot be un-launched mid-node) and
 *             are persisted normally. Nothing is discarded.
 *   resume  — clears `pausedAt` and moves PAUSED → QUEUED, then re-dispatches the
 *             orchestrator. Resumption never replays finished work: a case is
 *             claimed with a conditional update (PENDING → RUNNING), so only the
 *             executions that never started are picked up.
 */

import type { ExperimentStatus } from "./experiment.types";
import { ExperimentConflictError } from "./experiment.types";

export const EXPERIMENT_TRANSITIONS: Record<ExperimentStatus, readonly ExperimentStatus[]> = {
  DRAFT: ["QUEUED", "CANCELLED"],
  QUEUED: ["RUNNING", "PAUSED", "COMPLETED", "PARTIALLY_COMPLETED", "FAILED", "CANCELLED"],
  RUNNING: ["PAUSED", "COMPLETED", "PARTIALLY_COMPLETED", "FAILED", "CANCELLED"],
  PAUSED: ["QUEUED", "RUNNING", "COMPLETED", "PARTIALLY_COMPLETED", "FAILED", "CANCELLED"],
  COMPLETED: [],
  PARTIALLY_COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransitionExperiment(from: ExperimentStatus, to: ExperimentStatus): boolean {
  if (from === to) {
    return true;
  }
  return EXPERIMENT_TRANSITIONS[from].includes(to);
}

export function assertExperimentTransition(from: ExperimentStatus, to: ExperimentStatus): void {
  if (!canTransitionExperiment(from, to)) {
    throw new ExperimentConflictError(
      `An experiment cannot move from ${from} to ${to}.`,
    );
  }
}

/** Only a draft (or an intentionally re-armed draft) can be sealed and launched. */
export function isLaunchableExperimentStatus(status: ExperimentStatus): boolean {
  return status === "DRAFT";
}

export function isCancellableExperimentStatus(status: ExperimentStatus): boolean {
  return status === "DRAFT" || status === "QUEUED" || status === "RUNNING" || status === "PAUSED";
}

/** Only a running experiment can be paused — a paused one is already paused. */
export function isPausableExperimentStatus(status: ExperimentStatus): boolean {
  return status === "QUEUED" || status === "RUNNING";
}

export function isResumableExperimentStatus(status: ExperimentStatus): boolean {
  return status === "PAUSED";
}

/**
 * The status a settled experiment ends in, derived from its execution counts —
 * never from a counter the orchestrator kept in memory.
 */
export function settleExperimentStatus(input: {
  completed: number;
  failed: number;
  skipped: number;
  cancelled: number;
  pending: number;
  running: number;
  cancelledByRequest: boolean;
  budgetStop: boolean;
}): ExperimentStatus {
  const outstanding = input.pending + input.running;
  // A cancellation or a budget stop ends the experiment on purpose: cases that
  // never started were cancelled or capped by the budget, so waiting for them
  // would leave the experiment "running" forever. Only honest in-flight work
  // (or a deliberate pause, which the caller preserves) keeps it running.
  if (input.cancelledByRequest) {
    return "CANCELLED";
  }
  if (input.budgetStop) {
    return input.completed > 0 ? "PARTIALLY_COMPLETED" : "FAILED";
  }
  if (outstanding > 0) {
    return "RUNNING";
  }
  const settled = input.completed + input.failed + input.skipped + input.cancelled;
  if (settled === 0) {
    return "FAILED";
  }
  if (input.cancelled > 0) {
    return "PARTIALLY_COMPLETED";
  }
  if (input.failed > 0 && input.completed > 0) {
    return "PARTIALLY_COMPLETED";
  }
  if (input.failed > 0 && input.completed === 0) {
    return "FAILED";
  }
  if (input.skipped > 0 && input.completed === 0) {
    return "FAILED";
  }
  return "COMPLETED";
}

/** Explains a transition for logs and the API response. */
export function describeTransition(from: ExperimentStatus, to: ExperimentStatus): string {
  return `experiment ${from} → ${to}`;
}
