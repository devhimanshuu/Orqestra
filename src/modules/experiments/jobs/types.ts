import type { ExperimentStatus } from "../experiment.types";

/**
 * Outcome of one orchestration pass.
 *
 * Counts describe *this pass*; the experiment's authoritative state is always
 * re-read from its rows afterwards (see `finalizeExperiment`).
 */
export interface ExperimentRunSummary {
  experimentId: string;
  /** False when another pass held the claim (no work was done). */
  claimed: boolean;
  /** Executions this pass scheduled. */
  scheduled: number;
  completed: number;
  failed: number;
  cancelled: number;
  skipped: number;
  /** Cases a previous (dead) pass left interrupted and this pass recovered. */
  recovered: number;
  /** True when the pass stopped early because a budget was exhausted. */
  budgetStop: boolean;
  /** True when the pass stopped early because the experiment was paused. */
  paused: boolean;
  /** Terminal (or interim) status after the pass reconciled the experiment. */
  status?: ExperimentStatus;
}

export type ExperimentJobOutcome = { kind: "experiment"; summary: ExperimentRunSummary };
