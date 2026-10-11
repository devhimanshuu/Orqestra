import type { RuntimeExecutionLimits } from "@/modules/runtime/state/execution-state";
import type { DatasetCaseSnapshot } from "./dataset.types";
import type {
  AggregateStatus,
  EvaluationResultRecord,
  EvaluatorKind,
  ScoringPolicy,
} from "./evaluation.types";
import type { BatchMetrics } from "./metrics";

/**
 * Evaluation batch domain types.
 *
 * A batch is a *sealed experiment*: at creation it snapshots the harness
 * version, the dataset cases and every evaluator revision it will use. Nothing
 * after creation can change what the batch meant — only its status and results
 * move forward.
 */

export const BATCH_STATUSES = [
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "PARTIALLY_COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

export const CASE_STATUSES = [
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "SKIPPED",
  "CANCELLED",
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export function isTerminalBatchStatus(status: BatchStatus): boolean {
  return status === "COMPLETED" || status === "PARTIALLY_COMPLETED" || status === "FAILED" || status === "CANCELLED";
}

/** One evaluator revision pinned into a batch. */
export interface EvaluatorAssignmentSnapshot {
  /** `<evaluatorId>@<version>` — the identity results are keyed by. */
  key: string;
  evaluatorId: string;
  evaluatorVersion: number;
  kind: EvaluatorKind;
  name: string;
  weight: number;
  config: Record<string, unknown>;
  /** Recorded so the UI can label a verdict as a judgement. */
  usesLlm: boolean;
}

/** The harness version a batch ran against. */
export interface HarnessSnapshot {
  harnessId: string;
  harnessVersionId: string;
  harnessVersion: number;
  harnessName: string;
  contentHash: string;
  entryNode: string;
  nodeCount: number;
  edgeCount: number;
}

export interface BatchConfig {
  /** Case-level parallelism. Bounded by the platform ceiling. */
  concurrency: number;
  /** Per-case runtime budgets (clamped again by the run service). */
  limits: Partial<RuntimeExecutionLimits> | null;
}

export interface EvaluationBatchRecord {
  id: string;
  projectId: string;
  label: string | null;
  agentId: string;
  harnessId: string;
  harnessVersionId: string;
  datasetId: string;
  datasetVersionId: string;
  datasetSnapshot: DatasetCaseSnapshot[];
  evaluatorConfig: EvaluatorAssignmentSnapshot[];
  harnessSnapshot: HarnessSnapshot;
  scoringPolicy: ScoringPolicy;
  passThreshold: number | null;
  status: BatchStatus;
  caseCount: number;
  completedCount: number;
  failedCount: number;
  metrics: BatchMetrics | null;
  config: BatchConfig;
  cancelRequestedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EvaluationCaseRecord {
  id: string;
  batchId: string;
  caseKey: string;
  index: number;
  name: string | null;
  status: CaseStatus;
  runId: string | null;
  inputPreview: string | null;
  expectedOutput: unknown;
  tags: string[];
  aggregateScore: number | null;
  aggregateStatus: AggregateStatus | null;
  error: Record<string, unknown> | null;
  attempts: number;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EvaluationResultView extends EvaluationResultRecord {
  id: string;
  batchId: string | null;
  caseResultId: string | null;
  runId: string | null;
  createdAt: Date;
}

export interface BatchProgress {
  status: BatchStatus;
  caseCount: number;
  completedCount: number;
  failedCount: number;
  pending: number;
  running: number;
  cancelled: number;
  /** 0…1 of cases that reached a terminal status. */
  percent: number;
  cancellable: boolean;
}

export interface EvaluationBatchDetail {
  batch: EvaluationBatchRecord;
  progress: BatchProgress;
  agent: { id: string; name: string } | null;
  harness: { id: string; name: string; slug: string } | null;
  dataset: { id: string; name: string; slug: string; version: number } | null;
}

/** Compact row for the batches table. */
export interface BatchListItem {
  id: string;
  label: string | null;
  status: BatchStatus;
  harnessId: string;
  harnessName: string;
  harnessVersionLabel: number;
  datasetId: string;
  datasetName: string;
  datasetVersion: number;
  caseCount: number;
  completedCount: number;
  failedCount: number;
  meanScore: number | null;
  passRate: number | null;
  costUsd: number | null;
  costKind: "estimated";
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

/**
 * Evaluations attached to one run, grouped by where they came from: a batch
 * case, or a one-off evaluation of the run itself. A run can have several — for
 * example scored by a batch, then re-scored after a rubric change — so this is
 * a list, not a single verdict.
 */
export interface RunEvaluationGroup {
  batchId: string | null;
  batchLabel: string | null;
  caseKey: string | null;
  caseStatus: CaseStatus | null;
  runStatus: string | null;
  createdAt: Date;
  aggregate: {
    score: number | null;
    status: AggregateStatus;
    passed: boolean | null;
    policy: ScoringPolicy;
    explanation: string;
    missing: string[];
    errored: string[];
  } | null;
  results: EvaluationResultView[];
}

export class EvaluationBatchNotFoundError extends Error {
  constructor(batchId: string) {
    super(`Evaluation batch "${batchId}" not found`);
    this.name = "EvaluationBatchNotFoundError";
  }
}

export class EvaluationBatchConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationBatchConflictError";
  }
}

export class EvaluationStartError extends Error {
  public readonly issues: Array<{ path: string; message: string }>;

  constructor(message: string, issues: Array<{ path: string; message: string }> = []) {
    super(message);
    this.name = "EvaluationStartError";
    this.issues = issues;
  }
}
