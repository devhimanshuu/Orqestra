/**
 * Experiment domain concepts (Phase 5–6).
 *
 *   Experiment     — a hypothesis: harness vN vs vM (or agent A vs B) over a dataset
 *   ExperimentRun  — the assignment of one run to one experiment variant
 *
 * Phase 0 pins the vocabulary; the tables arrive with the experiment engine.
 */

export const EXPERIMENT_STATUSES = ["draft", "running", "completed", "failed"] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

/** What varies between variants — always version-pinned, never "latest". */
export interface ExperimentVariant {
  id: string;
  label: string;
  harnessId: string;
  harnessVersionId: string;
  agentId?: string;
  agentVersion?: number;
  /** Traffic share in [0, 1]. */
  weight: number;
}

export interface ExperimentScoring {
  evaluatorIds: string[];
  primaryMetric: string;
}

export interface Experiment {
  id: string;
  projectId: string;
  name: string;
  hypothesis: string | null;
  datasetId: string;
  variants: ExperimentVariant[];
  scoring: ExperimentScoring;
  status: ExperimentStatus;
  createdAt: Date;
}

/** One run's assignment to one variant, with the scores it produced. */
export interface ExperimentRun {
  id: string;
  experimentId: string;
  variantId: string;
  runId: string;
  evaluationIds: string[];
  createdAt: Date;
}
