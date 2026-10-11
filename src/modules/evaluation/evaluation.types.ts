/**
 * Evaluation domain contracts (Phase 3).
 *
 * Vocabulary, fixed once:
 *
 *   Dataset      — a versioned collection of test cases (input + optional expected output)
 *   Evaluator    — a scoring procedure (deterministic check, or an LLM judge)
 *   Evaluation   — one evaluator's verdict on one run
 *   Batch        — a harness version × dataset version × evaluator set, executed case by case
 *
 * Two separations are load-bearing and are enforced by the types below:
 *
 *  1. **A failed run is not a failed evaluation.** `RunObservation.status` is the
 *     runtime's own record, passed through read-only. Evaluators never write to
 *     it; a crashing evaluator produces an ERROR result, and the run's status
 *     stays exactly as the runtime left it.
 *  2. **An evaluator produces a score and an explanation, never a claim about
 *     private reasoning.** Everything an evaluator is allowed to look at lives
 *     in `EvaluationInput` — the task, the final output, the expected output,
 *     and the *observable* execution record (steps, tools, nodes, usage).
 */

import type { LLMGateway } from "@/modules/llm/llm.gateway";
import type { Logger } from "@/lib/logging/logger";
import type { RunMetadata, RunStatus, RuntimeUsageRecord } from "@/modules/runtime/run.types";

/** Built-in evaluator kinds. New kinds are added here and in the registry. */
export const EVALUATOR_KINDS = [
  "exact_match",
  "contains",
  "json_schema",
  "tool_usage",
  "harness_compliance",
  "llm_judge",
] as const;

export type EvaluatorKind = (typeof EVALUATOR_KINDS)[number];

export function isEvaluatorKind(value: string): value is EvaluatorKind {
  return (EVALUATOR_KINDS as readonly string[]).includes(value);
}

/** Evaluator kinds that call a model (they must be labelled as judgement, not truth). */
export const LLM_EVALUATOR_KINDS: readonly EvaluatorKind[] = ["llm_judge"];

export function requiresLlm(kind: EvaluatorKind): boolean {
  return LLM_EVALUATOR_KINDS.includes(kind);
}

// ------------------------------------------------------------------------------
// Observables — what an evaluator may read
// ------------------------------------------------------------------------------

/** One persisted run step, reduced to what evaluation cares about. */
export interface ObservedStep {
  index: number;
  nodeId: string;
  nodeType: string;
  nodeLabel: string;
  status: string;
  durationMs: number | null;
  iteration: number | null;
  /** Set for `tool` nodes: the tool that was actually invoked. */
  toolId: string | null;
  /** Tool args (tool steps only), for invocation-argument constraints. */
  toolInput: unknown;
  input: unknown;
  output: unknown;
  error: { code: string; message: string } | null;
}

/**
 * The observable execution record of one run.
 *
 * This is a projection of persisted rows, not a live object: an evaluator can
 * read it, sort it, count it — never mutate the run through it.
 */
export interface RunObservation {
  runId: string;
  /** Execution status — owned by the runtime, read-only here. */
  status: RunStatus;
  /** The task the agent was given. */
  input: unknown;
  /** The harness's final output (null while running / when empty). */
  output: unknown;
  error: { code: string; message: string; retryable?: boolean } | null;
  attempt: number;
  retryOfRunId: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  latencyMs: number | null;
  usage: RuntimeUsageRecord[];
  usageTotal: {
    calls: number;
    totalTokens: number;
    costUsd: number | null;
    unknownCost: boolean;
  };
  metadata: RunMetadata | null;
  steps: ObservedStep[];
}

/** One dataset case as it was pinned into a batch. */
export interface EvaluationCaseSample {
  caseKey: string;
  name: string | null;
  input: unknown;
  expectedOutput: unknown;
  metadata: Record<string, unknown> | null;
  tags: string[];
}

/** The complete input to an evaluator run. */
export interface EvaluationInput {
  /** Observable execution record (never mutated). */
  run: RunObservation;
  /** The output under evaluation: the run's final output unless overridden. */
  output: unknown;
  /** The task. Convenience alias for `run.input`. */
  task: unknown;
  /** Reference answer, when the dataset/request supplied one. */
  expectedOutput: unknown;
  /** The dataset case this run came from, when it came from one. */
  case: EvaluationCaseSample | null;
}

/** Everything an evaluator may use besides its own configuration. */
export interface EvaluationContext {
  runId: string;
  caseKey: string | null;
  /** Stable identity of the evaluator for this evaluation. */
  evaluatorKey: string;
  logger?: Logger;
  signal?: AbortSignal;
  now: () => Date;
  /** Present only for kinds that are allowed to call a model. */
  llm?: { gateway: LLMGateway };
  /** Budget for a single judge call. */
  llmTimeoutMs?: number;
  /** Hard cap on judge output size (untrusted text). */
  maxResponseChars?: number;
}

/**
 * What an evaluator returns.
 *
 * `SKIPPED` exists so an evaluator can admit it has nothing to score (an exact
 * match with no expected answer, an LLM judge with no configured model): the
 * aggregate then reports the evaluation as incomplete instead of silently
 * counting a fabricated zero.
 */
export type EvaluationOutcome =
  | {
      status: "COMPLETED";
      score: number;
      maxScore: number;
      /** Optional explicit pass/fail; when omitted the caller applies thresholds. */
      passed?: boolean;
      /** Required: a score without a reason is not a usable evaluation. */
      explanation: string;
      /** Structured, machine-readable evidence (matched spans, failing paths…). */
      evidence?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    }
  | {
      status: "SKIPPED";
      /** Required: why the evaluator could not score this case. */
      explanation: string;
      evidence?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    };

export const EVALUATION_RESULT_STATUSES = ["COMPLETED", "ERROR", "SKIPPED"] as const;
export type EvaluationResultStatus = (typeof EVALUATION_RESULT_STATUSES)[number];

/** A persisted evaluator verdict, before it reaches the database. */
export interface EvaluationResultRecord {
  evaluatorKey: string;
  evaluatorId: string | null;
  evaluatorVersion: number | null;
  evaluatorName: string;
  kind: EvaluatorKind;
  status: EvaluationResultStatus;
  score: number | null;
  maxScore: number;
  /** score / maxScore, or null when the result carries no usable score. */
  normalizedScore: number | null;
  passed: boolean | null;
  explanation: string;
  evidence: Record<string, unknown> | null;
  durationMs: number;
  metadata: Record<string, unknown> | null;
}

// ------------------------------------------------------------------------------
// Aggregation
// ------------------------------------------------------------------------------

export const SCORING_POLICIES = ["REQUIRE_ALL", "IGNORE_MISSING"] as const;
export type ScoringPolicy = (typeof SCORING_POLICIES)[number];

export const AGGREGATE_STATUSES = ["COMPLETE", "INCOMPLETE", "FAILED"] as const;
export type AggregateStatus = (typeof AGGREGATE_STATUSES)[number];

/** One evaluator's weight in an aggregate, pinned at batch start. */
export interface EvaluatorAssignment {
  /** Snapshot key: `<evaluatorId>@<version>` or `<kind>@<version>` for ad-hoc. */
  key: string;
  evaluatorKey: string;
  /** Raw weight; normalised (sum = 1) before use. */
  weight: number;
}

export interface AggregateContribution {
  evaluatorKey: string;
  weight: number;
  normalizedScore: number;
  status: EvaluationResultStatus;
}

export interface AggregateScore {
  /** Weighted mean in [0, 1], or null when the policy refused to guess. */
  score: number | null;
  maxScore: 1;
  status: AggregateStatus;
  passed: boolean | null;
  policy: ScoringPolicy;
  contributions: AggregateContribution[];
  /** Weighted evaluators that produced no usable score. */
  missing: string[];
  /** Weighted evaluators that errored. */
  errored: string[];
  explanation: string;
}

// ------------------------------------------------------------------------------
// Errors
// ------------------------------------------------------------------------------

/** Thrown when an evaluator kind has no implementation (a configuration bug). */
export class EvaluatorNotFoundError extends Error {
  constructor(kind: string) {
    super(`No evaluator is registered for kind "${kind}"`);
    this.name = "EvaluatorNotFoundError";
  }
}

/**
 * A failing evaluator. Deliberately distinct from runtime errors: the batch
 * records an ERROR result and continues; it never rewrites the run.
 */
export class EvaluatorError extends Error {
  public readonly evaluatorKey: string;
  public readonly retryable: boolean;

  constructor(
    evaluatorKey: string,
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "EvaluatorError";
    this.evaluatorKey = evaluatorKey;
    this.retryable = options.retryable ?? false;
  }
}

/** Invalid evaluator configuration: a deterministic failure, never retried. */
export class EvaluatorConfigError extends EvaluatorError {
  constructor(evaluatorKey: string, message: string) {
    super(evaluatorKey, message, { retryable: false });
    this.name = "EvaluatorConfigError";
  }
}

/** Two batches that cannot be meaningfully compared. */
export class EvaluationComparisonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationComparisonError";
  }
}
