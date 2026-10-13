/**
 * Experiment domain contracts (Phase 4).
 *
 * Vocabulary, fixed once:
 *
 *   Experiment  — a sealed comparison of harness versions over one dataset
 *   Candidate   — one immutable HarnessVersion (the baseline, or a challenger)
 *   Replicate   — one repeated trial of a candidate (a sealed evaluation batch)
 *   Assignment  — one dataset case handed to one candidate (one ExperimentRun row)
 *
 * Design rules this file encodes:
 *
 *  1. **Nothing points at "latest".** A candidate pins a `harnessVersionId` and a
 *     content hash; the dataset is pinned by version. An experiment therefore
 *     cannot silently drift when someone edits a harness mid-flight.
 *  2. **Execution status is never duplicated.** A candidate's execution status,
 *     its run ids and its evaluator verdicts live in the Phase 3 records the
 *     candidate's batches own (`EvaluationBatch` / `EvaluationCaseResult` /
 *     `EvaluationResult`). The experiment layer reads them; it does not restate
 *     them, so the two can never disagree.
 *  3. **Missing data is not zero.** Every metric below is `number | null`, and
 *     `null` means "not measured". Rates over zero items are null, costs carry
 *     their estimate provenance, and a candidate with no scored cases is
 *     *incomplete*, not failing.
 */

import type { RuntimeExecutionLimits } from "@/modules/runtime/state/execution-state";
import type { DatasetCaseSnapshot } from "@/modules/evaluation/dataset.types";
import type { EvaluatorAssignmentSnapshot, BatchStatus, CaseStatus } from "@/modules/evaluation/batch.types";
import type { AggregateStatus, ScoringPolicy } from "@/modules/evaluation/evaluation.types";
import type { ExperimentMetrics } from "./experiment.metrics";

// ------------------------------------------------------------------------------
// Statuses
// ------------------------------------------------------------------------------

export const EXPERIMENT_STATUSES = [
  "DRAFT",
  "QUEUED",
  "RUNNING",
  "PAUSED",
  "COMPLETED",
  "PARTIALLY_COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

export const EXPERIMENT_CANDIDATE_ROLES = ["BASELINE", "CANDIDATE"] as const;
export type ExperimentCandidateRole = (typeof EXPERIMENT_CANDIDATE_ROLES)[number];

export const EXPERIMENT_SELECTION_KINDS = ["RECOMMENDED", "SELECTED"] as const;
export type ExperimentSelectionKind = (typeof EXPERIMENT_SELECTION_KINDS)[number];

/** A status the experiment can no longer leave. */
export function isTerminalExperimentStatus(status: ExperimentStatus): boolean {
  return (
    status === "COMPLETED" ||
    status === "PARTIALLY_COMPLETED" ||
    status === "FAILED" ||
    status === "CANCELLED"
  );
}

/** True while cases may still be scheduled. */
export function isActiveExperimentStatus(status: ExperimentStatus): boolean {
  return status === "QUEUED" || status === "RUNNING" || status === "PAUSED";
}

// ------------------------------------------------------------------------------
// Objective, constraints, execution
// ------------------------------------------------------------------------------

/**
 * The metrics an experiment objective may optimize. Keys are stable strings so a
 * stored objective stays interpretable even if the UI's labels change.
 */
export const EXPERIMENT_METRIC_KEYS = [
  "evaluation_score",
  "pass_rate",
  "failure_rate",
  "median_latency_ms",
  "p95_latency_ms",
  "average_total_tokens",
  "total_tokens",
  "estimated_cost_usd",
  "tool_calls_per_case",
] as const;
export type ExperimentMetricKey = (typeof EXPERIMENT_METRIC_KEYS)[number];

export type MetricDirection = "maximize" | "minimize";

export interface ExperimentMetricSpec {
  metric: ExperimentMetricKey;
  direction: MetricDirection;
}

export interface ExperimentObjective {
  primary: ExperimentMetricSpec;
  /** Compared alongside the primary metric, never used to override it silently. */
  secondary: ExperimentMetricSpec[];
  /** Free-form note from the author (displayed with the result, never parsed). */
  notes: string | null;
}

/**
 * Hard constraints. A candidate that violates one is *ineligible*: it must not
 * be presented as the winner merely because its primary metric is higher.
 * Every limit is nullable, and null means "no constraint configured".
 */
export interface ExperimentConstraints {
  /** Ceiling on the estimated total cost of the candidate across the experiment. */
  maxTotalCostUsd: number | null;
  /** Ceiling on the candidate's median per-case latency. */
  maxMedianLatencyMs: number | null;
  /** Floor on the candidate's pass rate (0…1). */
  minPassRate: number | null;
  /** Floor on the candidate's mean aggregate score (0…1). */
  minMeanScore: number | null;
  /** Ceiling on the candidate's total reported tokens. */
  maxTotalTokens: number | null;
  /** Ceiling on the candidate's tool invocations per scored case. */
  maxToolCallsPerCase: number | null;
}

export const EMPTY_EXPERIMENT_CONSTRAINTS: ExperimentConstraints = {
  maxTotalCostUsd: null,
  maxMedianLatencyMs: null,
  minPassRate: null,
  minMeanScore: null,
  maxTotalTokens: null,
  maxToolCallsPerCase: null,
};

/** Which dataset cases take part, and how many at most. */
export interface ExperimentCaseSelection {
  /** Case tags to include (empty = every tag). */
  tags: string[];
  /** Explicit case keys to include (empty = every case). */
  caseKeys: string[];
  /** Optional cap on the selected cases, applied after tag/key filtering. */
  limit: number | null;
}

export function isDefaultCaseSelection(selection: ExperimentCaseSelection): boolean {
  return selection.tags.length === 0 && selection.caseKeys.length === 0 && selection.limit === null;
}

export const EXPERIMENT_ORDERINGS = ["interleaved", "baseline_first", "random"] as const;
export type ExperimentOrdering = (typeof EXPERIMENT_ORDERINGS)[number];

export interface ExperimentRetryPolicy {
  /** Attempts per case, including the first. Transient failures only. */
  maxAttempts: number;
}

export interface ExperimentBudget {
  /** Hard ceiling on executions this experiment may start. */
  maxRuns: number | null;
  /** Hard ceiling on tokens the experiment's runs may report. */
  maxTotalTokens: number | null;
  /** Ceiling on the estimated cost, enforced against measured usage. */
  maxCostUsd: number | null;
}

export interface ExperimentExecution {
  /** Cases executed in parallel *across candidates* (the platform clamps this). */
  concurrency: number;
  ordering: ExperimentOrdering;
  /** Seed for `random` ordering — recorded so a run can be explained. */
  randomSeed: number | null;
  /** Repeated trials per case, 1…N. Each replicate is its own sealed batch. */
  replicates: number;
  caseSelection: ExperimentCaseSelection;
  /** Per-case wall-clock ceiling passed to the runtime (null = runtime default). */
  timeoutMs: number | null;
  /** Runtime budget overrides for each case (clamped again by the run service). */
  limits: Partial<RuntimeExecutionLimits> | null;
  retryPolicy: ExperimentRetryPolicy;
  budget: ExperimentBudget;
}

// ------------------------------------------------------------------------------
// Sealed snapshots
// ------------------------------------------------------------------------------

/** The harness version a candidate pins, captured at launch. */
export interface ExperimentHarnessSnapshot {
  harnessId: string;
  harnessVersionId: string;
  harnessVersion: number;
  harnessName: string;
  contentHash: string;
  entryNode: string;
  nodeCount: number;
  edgeCount: number;
}

/**
 * The complete immutable configuration of an experiment, written once at launch.
 *
 * It exists so the experiment stays interpretable after the editable things it
 * points at have moved on: harness name, dataset contents, evaluator configs,
 * the objective, the constraints and the pricing table are all recorded here.
 * No credential, token or provider secret is ever stored in it.
 */
export interface ExperimentConfigSnapshot {
  schemaVersion: 1;
  /** Engine version that will execute the cases. */
  runtimeEngineVersion: string;
  /** Pricing table revision used for every cost estimate in this experiment. */
  pricingVersion: string;
  scoringPolicy: ScoringPolicy;
  passThreshold: number | null;
  objective: ExperimentObjective;
  constraints: ExperimentConstraints;
  execution: ExperimentExecution;
  dataset: {
    id: string;
    versionId: string;
    version: number;
    contentHash: string;
    /** Cases selected for execution (after tag/key filtering). */
    caseCount: number;
    /** Total cases available in the pinned dataset version. */
    availableCaseCount: number;
    selectedCaseKeys: string[];
  };
  evaluators: EvaluatorAssignmentSnapshot[];
  candidates: Array<{
    label: string;
    role: ExperimentCandidateRole;
    hypothesis: string | null;
    harnessId: string;
    harnessVersionId: string;
    harnessVersion: number;
    contentHash: string;
  }>;
  /** What cannot be reproduced exactly, stated instead of implied. */
  reproducibilityNotes: string[];
}

// ------------------------------------------------------------------------------
// Persisted records
// ------------------------------------------------------------------------------

export interface ExperimentRecord {
  id: string;
  projectId: string;
  agentId: string;
  name: string;
  description: string | null;
  hypothesis: string | null;
  status: ExperimentStatus;
  datasetId: string;
  datasetVersionId: string;
  datasetSnapshot: DatasetCaseSnapshot[];
  evaluatorConfig: EvaluatorAssignmentSnapshot[];
  scoringPolicy: ScoringPolicy;
  passThreshold: number | null;
  objective: ExperimentObjective;
  constraints: ExperimentConstraints;
  execution: ExperimentExecution;
  configSnapshot: ExperimentConfigSnapshot | null;
  caseCount: number;
  plannedRunCount: number;
  metrics: ExperimentMetrics | null;
  selectedCandidateId: string | null;
  selectionKind: ExperimentSelectionKind | null;
  selectionNotes: string | null;
  selectedBy: string | null;
  selectedAt: Date | null;
  promotedCandidateId: string | null;
  promotionNotes: string | null;
  promotedBy: string | null;
  promotedAt: Date | null;
  cancelRequestedAt: Date | null;
  pausedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExperimentCandidateRecord {
  id: string;
  experimentId: string;
  label: string;
  role: ExperimentCandidateRole;
  hypothesis: string | null;
  orderIndex: number;
  harnessId: string;
  harnessVersionId: string;
  harnessVersion: number;
  contentHash: string;
  harnessSnapshot: ExperimentHarnessSnapshot;
  createdAt: Date;
  /** One row per replicate; replicate 1 is always present. */
  replicates: ExperimentReplicateRecord[];
}

export interface ExperimentReplicateRecord {
  id: string;
  candidateId: string;
  replicate: number;
  evaluationBatchId: string;
}

export interface ExperimentAssignmentRecord {
  id: string;
  experimentId: string;
  candidateId: string;
  datasetVersionId: string;
  caseKey: string;
  index: number;
  orderIndex: number;
  replicate: number;
  createdAt: Date;
}

/** Counts for one candidate, derived from its batches' case rows. */
export interface CandidateProgress {
  candidateId: string;
  caseCount: number;
  plannedExecutions: number;
  completed: number;
  failed: number;
  skipped: number;
  cancelled: number;
  running: number;
  pending: number;
  percent: number;
}

export interface ExperimentProgress {
  status: ExperimentStatus;
  /** Selected dataset cases (one per aligned case, not per candidate). */
  caseCount: number;
  /** Planned executions across every candidate and replicate. */
  plannedExecutions: number;
  completed: number;
  failed: number;
  cancelled: number;
  skipped: number;
  running: number;
  pending: number;
  /** 0…1 of planned executions that reached a terminal status. */
  percent: number;
  candidates: CandidateProgress[];
  cancellable: boolean;
  pausable: boolean;
  resumable: boolean;
}

// ------------------------------------------------------------------------------
// Derived views
// ------------------------------------------------------------------------------

/** One candidate, with the status of its execution vehicle(s). */
export interface ExperimentCandidateSummary {
  id: string;
  label: string;
  role: ExperimentCandidateRole;
  hypothesis: string | null;
  orderIndex: number;
  harnessId: string;
  harnessVersionId: string;
  harnessVersion: number;
  contentHash: string;
  harnessName: string;
  /** Batch status per replicate, ordered by replicate number. */
  batchStatuses: Array<{ replicate: number; batchId: string; status: BatchStatus }>;
  progress: CandidateProgress;
}

export interface ExperimentDetail {
  experiment: ExperimentRecord;
  progress: ExperimentProgress;
  agent: { id: string; name: string } | null;
  harnessCount: number;
  dataset: { id: string; name: string; slug: string; version: number } | null;
  candidates: ExperimentCandidateSummary[];
  /** Names of the evaluators pinned at launch. */
  evaluators: Array<{ key: string; name: string; kind: string; version: number; weight: number; usesLlm: boolean }>;
}

/** Compact row for the experiments table. */
export interface ExperimentListItem {
  id: string;
  name: string;
  status: ExperimentStatus;
  agentId: string;
  agentName: string;
  candidateCount: number;
  caseCount: number;
  plannedRunCount: number;
  datasetId: string;
  datasetName: string;
  datasetVersion: number;
  baselineHarnessVersion: number | null;
  primaryMetric: ExperimentMetricKey;
  primaryDirection: MetricDirection;
  /** Leading candidate label, only when the current evidence names one. */
  leadingCandidateLabel: string | null;
  /** Why there is no leader yet, when there is none. */
  leaderNote: string | null;
  completedExecutions: number;
  failedExecutions: number;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

/**
 * One dataset case, as executed by one candidate. `replicates` holds every
 * trial; the per-case value is the mean over the trials that produced a score.
 */
export interface ExperimentCaseObservation {
  caseKey: string;
  index: number;
  name: string | null;
  tags: string[];
  /** Per-replicate execution rows (already linked to runs and verdicts). */
  trials: Array<{
    replicate: number;
    evaluationBatchId: string;
    caseResultId: string | null;
    status: CaseStatus;
    runId: string | null;
    aggregateScore: number | null;
    aggregateStatus: AggregateStatus | null;
    passed: boolean | null;
    attempts: number;
    error: Record<string, unknown> | null;
    durationMs: number | null;
    totalTokens: number | null;
    toolCalls: number;
    /** Node executions in this trial — a changed path is a lead worth reading. */
    steps: number | null;
  }>;
  /** Mean aggregate score over the scored trials (null when none scored). */
  meanScore: number | null;
  /** Passed at every scored trial when replicates > 1 (strict, documented). */
  passed: boolean | null;
  scoredTrials: number;
}

// ------------------------------------------------------------------------------
// Errors
// ------------------------------------------------------------------------------

export class ExperimentNotFoundError extends Error {
  constructor(experimentId: string) {
    super(`Experiment "${experimentId}" not found`);
    this.name = "ExperimentNotFoundError";
  }
}

export class ExperimentConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExperimentConflictError";
  }
}

export class ExperimentCandidateNotFoundError extends Error {
  constructor(candidateId: string) {
    super(`Experiment candidate "${candidateId}" not found`);
    this.name = "ExperimentCandidateNotFoundError";
  }
}

/** A configuration problem: the request is understood but cannot be run as asked. */
export class ExperimentValidationError extends Error {
  public readonly issues: Array<{ path: string; message: string }>;

  constructor(message: string, issues: Array<{ path: string; message: string }> = []) {
    super(message);
    this.name = "ExperimentValidationError";
    this.issues = issues;
  }
}

/** Candidate selection / promotion refused for a stated reason. */
export class ExperimentSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExperimentSelectionError";
  }
}

export class ExperimentPromotionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExperimentPromotionError";
  }
}

/** Two candidates (or an experiment/candidate pair) that cannot be compared. */
export class ExperimentComparisonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExperimentComparisonError";
  }
}
