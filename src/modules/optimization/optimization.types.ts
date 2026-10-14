/**
 * Optimization domain contracts (Phase 5).
 *
 * Vocabulary, fixed once:
 *
 *   Session      — one bounded improvement process over one baseline version
 *   Finding       — an observed weakness, linked to the real cases that show it
 *   Hypothesis    — a testable claim + the smallest change that would test it
 *   Candidate     — an isolated harness version produced by typed mutations
 *   Mutation      — one schema-validated change, with its before/after values
 *   Decision      — the deterministic accept/reject verdict on a candidate
 *   Event         — the append-only timeline that makes the loop auditable
 *
 * Design rules this file encodes:
 *
 *  1. **Nothing points at "latest".** A session pins its baseline harness
 *     version, its source batch, its dataset version and its evaluator
 *     revisions at launch; a candidate pins the version it published.
 *  2. **A published harness is never touched.** Candidates are new immutable
 *     versions created from a mutated copy of the baseline definition; the
 *     harness's own draft and `currentVersion` are not written.
 *  3. **Missing data is not zero.** Every measurement is `number | null` and
 *     `null` means "not measured"; a rate over zero cases is null. An
 *     improvement that cannot be evidenced is *inconclusive*, never claimed.
 *  4. **The model proposes; the platform decides.** LLM output is untrusted
 *     data: it becomes typed operations only after schema validation, and every
 *     acceptance decision is deterministic, testable code.
 */

import type { BatchMetrics } from "@/modules/evaluation/metrics";
import type { AggregateStatus, ScoringPolicy } from "@/modules/evaluation/evaluation.types";
import type { CaseStatus, EvaluatorAssignmentSnapshot } from "@/modules/evaluation/batch.types";
import type { ExperimentMetricKey, MetricDirection } from "@/modules/experiments/experiment.types";

// ------------------------------------------------------------------------------
// Statuses
// ------------------------------------------------------------------------------

export const OPTIMIZATION_STATUSES = [
  "DRAFT",
  "QUEUED",
  "RUNNING",
  "WAITING_FOR_REVIEW",
  "COMPLETED",
  "PARTIALLY_COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export type OptimizationStatus = (typeof OPTIMIZATION_STATUSES)[number];

/** The statuses a session can only ever be in once, at the end of its life. */
export type TerminalOptimizationStatus = Extract<
  OptimizationStatus,
  "COMPLETED" | "PARTIALLY_COMPLETED" | "FAILED" | "CANCELLED"
>;

export const OPTIMIZATION_STRATEGIES = ["RULE_BASED", "LLM_ASSISTED", "MANUAL"] as const;
export type OptimizationStrategyKind = (typeof OPTIMIZATION_STRATEGIES)[number];

export const CANDIDATE_STATUSES = [
  "PROPOSED",
  "VALIDATING",
  "INVALID",
  "EVALUATING",
  "EVALUATED",
  "FAILED",
] as const;
export type OptimizationCandidateStatus = (typeof CANDIDATE_STATUSES)[number];

export const DECISION_KINDS = ["ACCEPT", "REJECT", "INCONCLUSIVE"] as const;
export type OptimizationDecisionKind = (typeof DECISION_KINDS)[number];

/** A status the session can no longer leave. */
export function isTerminalOptimizationStatus(status: OptimizationStatus): boolean {
  return (
    status === "COMPLETED" ||
    status === "PARTIALLY_COMPLETED" ||
    status === "FAILED" ||
    status === "CANCELLED"
  );
}

/** True while a worker pass may hold the session. */
export function isActiveOptimizationStatus(status: OptimizationStatus): boolean {
  return status === "QUEUED" || status === "RUNNING" || status === "WAITING_FOR_REVIEW";
}

// ------------------------------------------------------------------------------
// Failure categories
// ------------------------------------------------------------------------------

/**
 * The canonical weakness taxonomy. Membership is stable (the strings are stored
 * in `FailureFinding.category`), so a stored finding stays interpretable.
 */
export const FAILURE_CATEGORIES = [
  "incorrect_final_answer",
  "missing_required_information",
  "invalid_structured_output",
  "missing_tool_usage",
  "inappropriate_tool_usage",
  "excessive_tool_calls",
  "repeated_tool_calls",
  "tool_error_recovery_failure",
  "excessive_loop_iterations",
  "premature_termination",
  "termination_limit_exceeded",
  "excessive_latency",
  "excessive_token_usage",
  "harness_policy_violation",
  "inconsistent_trials",
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export function isFailureCategory(value: string): value is FailureCategory {
  return (FAILURE_CATEGORIES as readonly string[]).includes(value);
}

/** Evidence quality markers. `llm` marks a finding a model shaped, not observed. */
export const FINDING_CONFIDENCE = ["high", "medium", "low", "llm"] as const;
export type FindingConfidence = (typeof FINDING_CONFIDENCE)[number];

// ------------------------------------------------------------------------------
// Objective and constraints
// ------------------------------------------------------------------------------

export interface OptimizationMetricSpec {
  metric: ExperimentMetricKey;
  direction: MetricDirection;
}

export interface OptimizationObjective {
  primary: OptimizationMetricSpec;
  secondary: OptimizationMetricSpec[];
  /** Improvement the primary metric must show, as a fraction of the baseline. */
  minImprovementPct: number;
  notes: string | null;
}

/**
 * Hard constraints. A candidate that violates one is *ineligible* — a higher
 * primary score never overrides them.
 *
 * Two families, deliberately distinguished:
 *  - absolute ceilings/floors on the candidate's own measurements;
 *  - relative limits against the baseline (cost/latency regressions), because
 *    "did this get more expensive than what we have" is the question the
 *    developer actually asked.
 */
export interface OptimizationConstraints {
  minPassRate: number | null;
  minMeanScore: number | null;
  maxMedianLatencyMs: number | null;
  maxTotalTokens: number | null;
  maxTotalCostUsd: number | null;
  /** Relative ceilings, as fractions of the baseline (0.2 = +20%). */
  maxCostIncreasePct: number | null;
  maxLatencyIncreasePct: number | null;
  /** Allowed drop of the primary metric versus the baseline (fraction). */
  maxQualityRegressionPct: number | null;
}

export const EMPTY_OPTIMIZATION_CONSTRAINTS: OptimizationConstraints = {
  minPassRate: null,
  minMeanScore: null,
  maxMedianLatencyMs: null,
  maxTotalTokens: null,
  maxTotalCostUsd: null,
  maxCostIncreasePct: null,
  maxLatencyIncreasePct: null,
  maxQualityRegressionPct: null,
};

/**
 * Loop ceilings. Every one of them is a *guard*, not a preference: the loop is
 * bounded whatever the hypotheses would like to do.
 */
export interface OptimizationLimits {
  maxIterations: number;
  maxCandidatesPerIteration: number;
  maxCandidates: number;
  maxRuns: number;
  maxTotalTokens: number | null;
  maxCostUsd: number | null;
  maxElapsedMs: number | null;
  /** Consecutive structurally invalid candidates tolerated before stopping. */
  maxConsecutiveInvalid: number;
  /** Iterations without an accepted improvement before stopping. */
  stallIterations: number;
  /** A human must approve a valid candidate before it is evaluated. */
  requireApprovalBeforeEvaluation: boolean;
  /**
   * The "provider:model" the LLM-assisted strategy may use to *propose* changes.
   * Null disables it. This is a model reference, never a credential: keys stay in
   * the environment, and the analyzer's usage is accounted separately from the
   * agent runs it reasons about.
   */
  analyzerModel: string | null;
}

export const DEFAULT_OPTIMIZATION_LIMITS: OptimizationLimits = {
  maxIterations: 3,
  maxCandidatesPerIteration: 1,
  maxCandidates: 6,
  maxRuns: 60,
  maxTotalTokens: null,
  maxCostUsd: null,
  maxElapsedMs: null,
  maxConsecutiveInvalid: 3,
  stallIterations: 2,
  requireApprovalBeforeEvaluation: false,
  analyzerModel: null,
};

// ------------------------------------------------------------------------------
// Sealed session configuration
// ------------------------------------------------------------------------------

/** The complete immutable configuration of a session, written once at launch. */
export interface OptimizationConfigSnapshot {
  schemaVersion: 1;
  scoringPolicy: ScoringPolicy;
  passThreshold: number | null;
  objective: OptimizationObjective;
  constraints: OptimizationConstraints;
  limits: OptimizationLimits;
  strategy: OptimizationStrategyKind;
  /** The baseline the loop improves on, pinned by version and content hash. */
  baseline: {
    harnessId: string;
    harnessVersionId: string;
    harnessVersion: number;
    contentHash: string;
    entryNode: string;
    nodeCount: number;
    edgeCount: number;
  };
  /** The evidence the loop starts from. */
  sourceBatch: {
    batchId: string;
    status: string;
    caseCount: number;
    completedCount: number;
    failedCount: number;
    metrics: BatchMetrics | null;
  };
  dataset: { id: string; versionId: string; version: number; caseCount: number };
  evaluators: EvaluatorAssignmentSnapshot[];
  reproducibilityNotes: string[];
}

// ------------------------------------------------------------------------------
// Persisted records
// ------------------------------------------------------------------------------

export interface FailureFindingRecord {
  id: string;
  sessionId: string;
  category: FailureCategory;
  summary: string;
  frequency: string | null;
  confidence: FindingConfidence;
  impact: string | null;
  investigation: string | null;
  isLlm: boolean;
  caseKeys: string[];
  runIds: string[];
  evaluatorKeys: string[];
  traceRefs: TraceRef[] | null;
  hypothesisIds: string[];
  createdAt: Date;
}

/** A pointer into real execution evidence. Never synthesized. */
export interface TraceRef {
  caseKey: string;
  runId: string | null;
  /** Step indexes worth reading, when the analysis saw them. */
  stepIndexes: number[];
  /** Why this reference is here. */
  note: string;
}

export interface ImprovementHypothesisRecord {
  id: string;
  sessionId: string;
  findingId: string | null;
  category: FailureCategory;
  title: string;
  observation: string;
  hypothesis: string;
  proposedChange: string;
  expectedOutcome: string;
  tradeoff: string | null;
  metricKeys: string[];
  acceptanceCriteria: Record<string, unknown> | null;
  confidence: FindingConfidence;
  requiresReview: boolean;
  origin: OptimizationStrategyKind;
  status: "PROPOSED" | "SELECTED" | "EXHAUSTED" | "SUPERSEDED";
  fingerprint: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface HarnessMutationRecord {
  id: string;
  candidateId: string;
  operation: string;
  target: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  risk: MutationRisk;
  applied: boolean;
  createdAt: Date;
}

export interface OptimizationCandidateRecord {
  id: string;
  sessionId: string;
  iteration: number;
  hypothesisId: string | null;
  label: string;
  draftId: string | null;
  versionId: string | null;
  contentHash: string | null;
  status: OptimizationCandidateStatus;
  validation: CandidateValidation | null;
  changeSet: MutationChange[] | null;
  /**
   * The exact definition this candidate carries, for candidates parked awaiting
   * human approval: it is what a resumed pass publishes and evaluates.
   */
  pendingDefinition: unknown | null;
  baselineMetrics: BatchMetrics | null;
  metrics: BatchMetrics | null;
  evaluationBatchId: string | null;
  decision: AcceptanceDecision | null;
  decisionKind: OptimizationDecisionKind | null;
  fingerprint: string;
  analyzerTokenUsage: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OptimizationSessionRecord {
  id: string;
  projectId: string;
  agentId: string;
  harnessId: string;
  name: string;
  description: string | null;
  status: OptimizationStatus;
  strategy: OptimizationStrategyKind;
  baselineVersionId: string;
  sourceBatchId: string;
  datasetId: string;
  datasetVersionId: string;
  evaluatorConfig: EvaluatorAssignmentSnapshot[];
  scoringPolicy: ScoringPolicy;
  passThreshold: number | null;
  objective: OptimizationObjective;
  constraints: OptimizationConstraints;
  limits: OptimizationLimits;
  configSnapshot: OptimizationConfigSnapshot | null;
  currentIteration: number;
  maxIterations: number;
  candidateCount: number;
  runCount: number;
  tokenUsage: number;
  estimatedCostUsd: number;
  analyzerTokenUsage: number;
  stopReason: string | null;
  report: OptimizationReport | null;
  bestCandidateId: string | null;
  promotedCandidateId: string | null;
  requireApproval: boolean;
  cancelRequestedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OptimizationEventRecord {
  id: string;
  sessionId: string;
  kind: string;
  message: string;
  ref: string | null;
  payload: Record<string, unknown> | null;
  createdAt: Date;
}

// ------------------------------------------------------------------------------
// Mutation vocabulary
// ------------------------------------------------------------------------------

export const MUTATION_RISKS = ["LOW", "MEDIUM", "HIGH"] as const;
export type MutationRisk = (typeof MUTATION_RISKS)[number];

/** Node types a mutation may insert. Deliberately small and behaviour-only. */
export const INSERTABLE_NODE_TYPES = ["critic", "prompt", "transform"] as const;
export type InsertableNodeType = (typeof INSERTABLE_NODE_TYPES)[number];

/** One typed change, already applied to a definition. */
export interface MutationChange {
  operation: string;
  /** Human-readable target, e.g. `nodes.reasoner.config.systemPrompt`. */
  target: string;
  before: unknown;
  after: unknown;
  reason: string;
  risk: MutationRisk;
}

/** Outcome of running typed operations against a definition. */
export interface MutationApplication {
  /** A new definition; the input is never mutated. */
  definition: unknown;
  applied: MutationChange[];
  /** Operations refused by the engine, with the reason — recorded, not dropped. */
  rejected: Array<{ operation: string; target: string; reason: string }>;
}

// ------------------------------------------------------------------------------
// Candidate validation and acceptance
// ------------------------------------------------------------------------------

export interface CandidateValidationIssue {
  code: string;
  message: string;
}

export interface CandidateValidation {
  ok: boolean;
  issues: CandidateValidationIssue[];
  /** Counts and shape of the validated graph, for the inspector. */
  nodeCount: number;
  edgeCount: number;
  entryNode: string | null;
}

export interface ConstraintViolation {
  /** `min_pass_rate`, `max_cost_increase_pct`, … */
  constraint: string;
  message: string;
  /** The measured value, when there is one. */
  observed: number | null;
  /** The limit that was exceeded. */
  limit: number;
}

export interface MetricDelta {
  metric: ExperimentMetricKey;
  direction: MetricDirection;
  baseline: number | null;
  candidate: number | null;
  /** candidate − baseline, only when both are measured. */
  delta: number | null;
  /** (candidate − baseline) / |baseline|, only when the baseline is non-zero. */
  relativeDelta: number | null;
  /** True when the movement is in the objective's improving direction. */
  improved: boolean | null;
}

export interface AcceptanceDecision {
  kind: OptimizationDecisionKind;
  /** Every reason the verdict rests on — shown verbatim in the UI. */
  reasons: string[];
  violations: ConstraintViolation[];
  deltas: MetricDelta[];
  /** `complete` | `partial` — did the candidate's evaluation cover the dataset. */
  evidenceCompleteness: "complete" | "partial" | "none";
  /**
   * Observed improvement and statistical confidence are separate facts: a
   * single-trial improvement is `indicative`, not `established`.
   */
  evidenceStrength: "established" | "indicative" | "inconclusive";
  scoredCases: number;
  evaluatedAt: string;
}

/** Inputs to the acceptance policy — pure values, no database access. */
export interface AcceptanceInput {
  objective: OptimizationObjective;
  constraints: OptimizationConstraints;
  baseline: BatchMetrics | null;
  candidate: BatchMetrics | null;
  /** Cases the candidate's batch was asked to execute. */
  plannedCases: number;
  /** Batch status of the candidate's evaluation. */
  batchStatus: string;
  /** Cases that produced a usable score on the baseline. */
  baselineScoredCases: number;
}

// ------------------------------------------------------------------------------
// Stopping conditions
// ------------------------------------------------------------------------------

export const STOP_REASONS = [
  "max_iterations",
  "max_candidates",
  "max_runs",
  "token_budget",
  "cost_budget",
  "time_budget",
  "no_hypotheses",
  "no_failures_found",
  "no_improvement",
  "consecutive_invalid",
  "cancelled",
  "infrastructure_failure",
  "awaiting_review",
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export interface StoppingInput {
  limits: OptimizationLimits;
  iterationsCompleted: number;
  candidateCount: number;
  runCount: number;
  tokenUsage: number;
  estimatedCostUsd: number;
  elapsedMs: number;
  consecutiveInvalid: number;
  /** Iterations since the last accepted candidate. */
  stallIterations: number;
  remainingHypotheses: number;
  cancelRequested: boolean;
}

export interface StoppingVerdict {
  stop: boolean;
  reason: StopReason | null;
  /** Why — one line per contributing condition. */
  notes: string[];
}

// ------------------------------------------------------------------------------
// Report
// ------------------------------------------------------------------------------

export interface OptimizationReport {
  kind: "orqestra.optimization-report";
  sessionId: string;
  status: OptimizationStatus;
  stopReason: StopReason | null;
  objective: OptimizationObjective;
  constraints: OptimizationConstraints;
  baseline: {
    harnessVersionId: string;
    harnessVersion: number;
    metrics: BatchMetrics | null;
  };
  iterations: Array<{
    iteration: number;
    hypothesis: string | null;
    candidates: Array<{
      candidateId: string;
      label: string;
      status: OptimizationCandidateStatus;
      decision: OptimizationDecisionKind | null;
      primaryDelta: number | null;
      violations: string[];
    }>;
  }>;
  findings: Array<{ category: FailureCategory; summary: string; frequency: string | null }>;
  accepted: Array<{ candidateId: string; label: string; versionId: string; reasons: string[] }>;
  rejected: Array<{ candidateId: string; label: string; reasons: string[] }>;
  recommendation: {
    candidateId: string | null;
    label: string | null;
    rationale: string[];
  };
  usage: {
    runs: number;
    agentTokens: number;
    analyzerTokens: number;
    estimatedCostUsd: number;
    durationMs: number | null;
  };
  generatedAt: string;
}

// ------------------------------------------------------------------------------
// Derived views (API/UI)
// ------------------------------------------------------------------------------

export interface OptimizationListItem {
  id: string;
  name: string;
  status: OptimizationStatus;
  agentId: string;
  agentName: string;
  harnessId: string;
  baselineVersion: number;
  strategy: OptimizationStrategyKind;
  sourceBatchId: string;
  datasetId: string;
  datasetName: string;
  caseCount: number;
  candidateCount: number;
  acceptedCount: number;
  currentIteration: number;
  maxIterations: number;
  bestCandidateId: string | null;
  bestCandidateLabel: string | null;
  stopReason: string | null;
  runCount: number;
  tokenUsage: number;
  estimatedCostUsd: number;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface OptimizationStats {
  total: number;
  running: number;
  completed: number;
  cancelled: number;
  failed: number;
  /** Sessions that produced at least one accepted candidate, over settled ones. */
  improvementRate: number | null;
  candidateEvaluations: number;
  runsUsed: number;
  estimatedCostUsd: number;
}

export interface OptimizationOverview {
  stats: OptimizationStats;
  recent: OptimizationListItem[];
}

// ------------------------------------------------------------------------------
// Analysis and hypothesis contracts
// ------------------------------------------------------------------------------

/** One case of the source batch, reduced to what analysis reads. */
export interface SourceCaseFacts {
  caseKey: string;
  index: number;
  name: string | null;
  tags: string[];
  status: CaseStatus;
  runId: string | null;
  runStatus: string | null;
  aggregateScore: number | null;
  aggregateStatus: AggregateStatus | null;
  passed: boolean | null;
  attempt: number;
  latencyMs: number | null;
  totalTokens: number | null;
  toolCalls: number;
  stepCount: number;
  /** Tool ids invoked, in execution order (a retried call appears twice). */
  toolsInvoked: string[];
  /** Step-level failures: the runtime's own record of what broke. */
  failedSteps: Array<{ index: number; nodeId: string; nodeType: string; code: string | null; message: string | null }>;
  /** Loop iterations observed per loop node (max over the run). */
  loopIterations: number | null;
  /** The case's own failure record, when execution failed. */
  error: { kind?: string; code?: string; message?: string } | null;
  results: Array<{
    evaluatorKey: string;
    evaluatorName: string;
    kind: string;
    status: string;
    passed: boolean | null;
    normalizedScore: number | null;
    explanation: string;
  }>;
}

/** Everything the analysis engine is allowed to look at. */
export interface AnalysisInput {
  sessionId: string;
  batchId: string;
  passThreshold: number | null;
  evaluatorConfig: EvaluatorAssignmentSnapshot[];
  cases: SourceCaseFacts[];
  metrics: BatchMetrics | null;
  /** Absolute thresholds that make "excessive" objective rather than a vibe. */
  thresholds?: Partial<AnalysisThresholds>;
}

export interface AnalysisThresholds {
  /** A run is late when it exceeds the batch's median by this factor. */
  latencyMedianFactor: number;
  /** …and this floor, so a fast batch does not flag 30ms as slow. */
  latencyFloorMs: number;
  /** Tool calls above this count are excessive, per case. */
  toolCallsPerCase: number;
  /** Identical tool invocations above this count are repetitive. */
  repeatedToolCalls: number;
  /** Node executions above this count suggest an unbounded loop. */
  stepsPerCase: number;
  /** Loop iterations above this count are excessive. */
  loopIterations: number;
  /** Tokens above this count per case are excessive. */
  tokensPerCase: number;
}

export const DEFAULT_ANALYSIS_THRESHOLDS: AnalysisThresholds = {
  latencyMedianFactor: 2,
  latencyFloorMs: 5_000,
  toolCallsPerCase: 8,
  repeatedToolCalls: 3,
  stepsPerCase: 30,
  loopIterations: 5,
  tokensPerCase: 8_000,
};

/** A hypothesis the rule engine proposes, before it is persisted. */
export interface ProposedHypothesis {
  category: FailureCategory;
  title: string;
  observation: string;
  hypothesis: string;
  proposedChange: string;
  expectedOutcome: string;
  tradeoff: string | null;
  metricKeys: string[];
  confidence: FindingConfidence;
  requiresReview: boolean;
  origin: OptimizationStrategyKind;
  /** The findings this hypothesis answers. */
  findingIds: string[];
  /** Typed operations the mutation engine will apply (validated there). */
  operations: unknown[];
  acceptanceCriteria: Record<string, unknown> | null;
}

// ------------------------------------------------------------------------------
// Errors
// ------------------------------------------------------------------------------

export class OptimizationNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Optimization session "${sessionId}" not found`);
    this.name = "OptimizationNotFoundError";
  }
}

export class OptimizationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OptimizationConflictError";
  }
}

export class OptimizationValidationError extends Error {
  public readonly issues: Array<{ path: string; message: string }>;

  constructor(message: string, issues: Array<{ path: string; message: string }> = []) {
    super(message);
    this.name = "OptimizationValidationError";
    this.issues = issues;
  }
}

export class OptimizationCandidateNotFoundError extends Error {
  constructor(candidateId: string) {
    super(`Optimization candidate "${candidateId}" not found`);
    this.name = "OptimizationCandidateNotFoundError";
  }
}

export class OptimizationPromotionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OptimizationPromotionError";
  }
}
