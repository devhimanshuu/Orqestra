/**
 * Evaluator registry — the one place evaluation orchestration reaches
 * evaluators through.
 *
 * Adding an evaluator means adding a definition to `BUILT_INS` and a kind to
 * `EVALUATOR_KINDS`; the orchestration layer never changes. `runEvaluator()`
 * is the single entry point: it validates configuration, times the run, turns
 * outcomes into persisted-shape records, and converts failures into ERROR
 * records that carry an explicit retryability flag — so a crashing evaluator
 * can neither pass a case nor be retried forever.
 */

import { ZodError, type ZodType } from "zod";
import {
  EvaluatorError,
  EvaluatorNotFoundError,
  type EvaluationContext,
  type EvaluationInput,
  type EvaluationOutcome,
  type EvaluationResultRecord,
  type EvaluatorKind,
} from "./evaluation.types";
import { normalizeScoreValue } from "./scoring";
import {
  EvaluatorConfigInvalid,
  type EvaluatorDefinition,
  type EvaluatorKindSummary,
} from "./evaluators/contract";
import { containsEvaluator } from "./evaluators/contains";
import { exactMatchEvaluator } from "./evaluators/exact-match";
import { harnessComplianceEvaluator } from "./evaluators/harness-compliance";
import { jsonSchemaEvaluator } from "./evaluators/json-schema";
import { llmJudgeEvaluator } from "./evaluators/llm-judge";
import { toolUsageEvaluator } from "./evaluators/tool-usage";

const BUILT_INS: ReadonlyArray<EvaluatorDefinition<unknown>> = [
  exactMatchEvaluator,
  containsEvaluator,
  jsonSchemaEvaluator,
  toolUsageEvaluator,
  harnessComplianceEvaluator,
  llmJudgeEvaluator,
] as unknown as ReadonlyArray<EvaluatorDefinition<unknown>>;

const registry = new Map<string, EvaluatorDefinition<unknown>>(
  BUILT_INS.map((definition) => [definition.kind, definition]),
);

export function getEvaluatorDefinition(kind: string): EvaluatorDefinition<unknown> {
  const definition = registry.get(kind);
  if (definition === undefined) {
    throw new EvaluatorNotFoundError(kind);
  }
  return definition;
}

export function hasEvaluator(kind: string): boolean {
  return registry.has(kind);
}

export function listEvaluatorDefinitions(): ReadonlyArray<EvaluatorDefinition<unknown>> {
  return [...registry.values()];
}

/** Serializable summaries for the evaluator picker. */
export function listEvaluatorKinds(): EvaluatorKindSummary[] {
  return [...registry.values()].map((definition) => ({
    kind: definition.kind,
    label: definition.label,
    description: definition.description,
    usesLlm: definition.usesLlm,
    configFields: definition.configFields,
    defaultConfig: definition.defaultConfig,
  }));
}

export interface ConfigValidationResult {
  ok: boolean;
  config: unknown;
  issues: Array<{ path: string; message: string }>;
}

/** Validates an evaluator configuration without running it. */
export function validateEvaluatorConfig(kind: string, config: unknown): ConfigValidationResult {
  let definition: EvaluatorDefinition<unknown>;
  try {
    definition = getEvaluatorDefinition(kind);
  } catch (error) {
    return {
      ok: false,
      config: null,
      issues: [
        {
          path: "kind",
          message: error instanceof Error ? error.message : `Unknown evaluator kind "${kind}"`,
        },
      ],
    };
  }
  const schema = definition.configSchema as ZodType;
  const parsed = schema.safeParse(config ?? definition.defaultConfig);
  if (!parsed.success) {
    return {
      ok: false,
      config: null,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        message: issue.message,
      })),
    };
  }
  return { ok: true, config: parsed.data, issues: [] };
}

export interface RunEvaluatorInput {
  /** Evaluator kind (must be registered). */
  kind: string;
  /** Snapshot identity recorded on the result. */
  evaluatorKey: string;
  evaluatorName: string;
  evaluatorId?: string | null;
  evaluatorVersion?: number | null;
  /** Raw configuration — validated here. */
  config: unknown;
  input: EvaluationInput;
  context: Omit<EvaluationContext, "evaluatorKey">;
  /** Retry attempt number, recorded in metadata for auditing. */
  attempt?: number;
}

function errorRecord(
  input: RunEvaluatorInput,
  message: string,
  durationMs: number,
  options: { retryable: boolean; kind: EvaluatorKind; configValid: boolean },
): EvaluationResultRecord {
  return {
    evaluatorKey: input.evaluatorKey,
    evaluatorId: input.evaluatorId ?? null,
    evaluatorVersion: input.evaluatorVersion ?? null,
    evaluatorName: input.evaluatorName,
    kind: options.kind,
    status: "ERROR",
    score: null,
    maxScore: 1,
    normalizedScore: null,
    passed: null,
    explanation: message,
    evidence: null,
    durationMs,
    metadata: {
      retryable: options.retryable,
      configValid: options.configValid,
      ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    },
  };
}

/**
 * Runs one evaluator against one observation and returns a record shaped for
 * `EvaluationResult`. Never throws: a failure is an ERROR result, and the run's
 * own status is untouched.
 */
export async function runEvaluator(input: RunEvaluatorInput): Promise<EvaluationResultRecord> {
  const startedAt = input.context.now();
  const elapsed = (): number => Math.max(0, input.context.now().getTime() - startedAt.getTime());

  let definition: EvaluatorDefinition<unknown>;
  try {
    definition = getEvaluatorDefinition(input.kind);
  } catch (error) {
    return errorRecord(
      input,
      error instanceof Error ? error.message : `Unknown evaluator kind "${input.kind}"`,
      elapsed(),
      { retryable: false, kind: "exact_match", configValid: false },
    );
  }

  const kind = definition.kind;
  const schema = definition.configSchema as ZodType;
  const parsed = schema.safeParse(input.config ?? definition.defaultConfig);
  if (!parsed.success) {
    return errorRecord(
      input,
      `Invalid configuration for "${definition.label}": ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
        .join("; ")}`,
      elapsed(),
      { retryable: false, kind, configValid: false },
    );
  }

  try {
    const outcome: EvaluationOutcome = await definition.evaluate(input.input, {
      ...input.context,
      evaluatorKey: input.evaluatorKey,
    }, parsed.data);
    const durationMs = elapsed();

    if (outcome.status === "SKIPPED") {
      return {
        evaluatorKey: input.evaluatorKey,
        evaluatorId: input.evaluatorId ?? null,
        evaluatorVersion: input.evaluatorVersion ?? null,
        evaluatorName: input.evaluatorName,
        kind,
        status: "SKIPPED",
        score: null,
        maxScore: 1,
        normalizedScore: null,
        passed: null,
        explanation: outcome.explanation,
        evidence: outcome.evidence ?? null,
        durationMs,
        metadata: { ...(outcome.metadata ?? {}), skipped: true },
      };
    }

    let normalizedScore: number;
    try {
      normalizedScore = normalizeScoreValue(outcome.score, outcome.maxScore);
    } catch (error) {
      return errorRecord(
        input,
        error instanceof Error ? error.message : "The evaluator reported an invalid score",
        durationMs,
        { retryable: false, kind, configValid: true },
      );
    }

    return {
      evaluatorKey: input.evaluatorKey,
      evaluatorId: input.evaluatorId ?? null,
      evaluatorVersion: input.evaluatorVersion ?? null,
      evaluatorName: input.evaluatorName,
      kind,
      status: "COMPLETED",
      score: outcome.score,
      maxScore: outcome.maxScore,
      normalizedScore,
      passed: outcome.passed ?? null,
      explanation: outcome.explanation,
      evidence: outcome.evidence ?? null,
      durationMs,
      metadata: {
        ...(outcome.metadata ?? {}),
        ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
      },
    };
  } catch (error) {
    const durationMs = elapsed();
    const message =
      error instanceof Error ? error.message : `Evaluator "${input.evaluatorKey}" failed`;
    const retryable =
      error instanceof EvaluatorError
        ? error.retryable
        : !(error instanceof EvaluatorConfigInvalid || error instanceof ZodError);
    return errorRecord(input, message, durationMs, { retryable, kind, configValid: true });
  }
}
