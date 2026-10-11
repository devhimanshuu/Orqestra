/**
 * Evaluator contract.
 *
 * Every evaluator is a pure-ish function with three inputs: the observation,
 * the context, and a config that has already been validated against the
 * evaluator's own strict schema. It returns a score plus an explanation.
 *
 * What an evaluator may NOT do:
 *  - mutate the run observation (the type is read-only by convention and the
 *    runner passes a frozen projection);
 *  - write to the database (persistence is the service layer's job);
 *  - claim certainty it does not have — an LLM judge must say so in its
 *    metadata, and deterministic evaluators must not call a model at all.
 */

import type { z } from "zod";
import type {
  EvaluationContext,
  EvaluationInput,
  EvaluationOutcome,
  EvaluatorKind,
} from "../evaluation.types";

/**
 * An evaluator configuration that is structurally valid but not usable (a
 * schema with keywords we do not implement, a required node id that is not in
 * the harness, …). Deterministic: never retried, always reported as-is.
 */
export class EvaluatorConfigInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluatorConfigInvalid";
  }
}

/** UI metadata for one configuration field of an evaluator. */
export interface EvaluatorConfigField {
  name: string;
  label: string;
  type: "string" | "number" | "boolean" | "string[]" | "model" | "json";
  required?: boolean;
  description?: string;
  default?: unknown;
}

export interface EvaluatorDefinition<TConfig> {
  kind: EvaluatorKind;
  /** Short label for the evaluator picker. */
  label: string;
  /** One sentence the UI shows under the label. */
  description: string;
  /** True when the evaluator calls a model and its verdict is a judgement. */
  usesLlm: boolean;
  /** Strict config schema: unknown keys are a configuration error. */
  configSchema: z.ZodType<TConfig>;
  configFields: EvaluatorConfigField[];
  /** Used when a request omits configuration. */
  defaultConfig: TConfig;
  evaluate(
    input: EvaluationInput,
    context: EvaluationContext,
    config: TConfig,
  ): Promise<EvaluationOutcome>;
}

/** Serializable summary of an evaluator kind, for the API and the UI. */
export interface EvaluatorKindSummary {
  kind: EvaluatorKind;
  label: string;
  description: string;
  usesLlm: boolean;
  configFields: EvaluatorConfigField[];
  defaultConfig: unknown;
}

/**
 * Throws away the generic parameter when evaluators are stored in a map. The
 * registry is the only place that needs this, and it re-validates the config
 * through `configSchema` before every call, so the erasure is safe.
 */
export type AnyEvaluatorDefinition = EvaluatorDefinition<unknown>;

/** Shared helpers used by more than one evaluator. */

/** Renders any JSON value as text for text-oriented evaluators. */
export function toText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface TextNormalization {
  caseSensitive: boolean;
  whitespace: boolean;
  lineEndings: boolean;
}

/**
 * Normalises text for comparison. The exact order matters and is documented:
 * line endings → whitespace → trim → case.
 */
export function normalizeText(text: string, options: TextNormalization): string {
  let result = text;
  if (options.lineEndings) {
    result = result.replace(/\r\n?/g, "\n");
  }
  if (options.whitespace) {
    result = result.replace(/[^\S\n]+/g, " ").replace(/\n{2,}/g, "\n");
  }
  result = result.trim();
  if (!options.caseSensitive) {
    result = result.toLowerCase();
  }
  return result;
}

/** Truncates a preview for an explanation or evidence payload. */
export function preview(value: unknown, maxLength = 160): string {
  const text = toText(value).replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
