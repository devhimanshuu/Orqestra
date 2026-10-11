import type { BatchStatus } from "../batch.types";

/**
 * Outcome of one orchestration pass. Counts describe *this pass*; the batch's
 * authoritative state is always re-read from its rows afterwards.
 */
export interface BatchRunSummary {
  batchId: string;
  /** False when another worker held the batch claim (no work was done). */
  claimed: boolean;
  completed: number;
  failed: number;
  cancelled: number;
  skipped: number;
  status?: BatchStatus;
}

export type EvaluationJobOutcome =
  | { kind: "batch"; summary: BatchRunSummary }
  | { kind: "case"; status: "completed" | "failed" | "cancelled" | "skipped" };
