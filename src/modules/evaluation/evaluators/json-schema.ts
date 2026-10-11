import { z } from "zod";
import {
  describeIssues,
  unsupportedKeywords,
  validateAgainstSchema,
  type JsonSchema,
  type JsonSchemaIssue,
} from "../json-schema";
import type { EvaluationInput, EvaluationOutcome } from "../evaluation.types";
import { EvaluatorConfigInvalid, preview, toText, type EvaluatorDefinition } from "./contract";

/**
 * JSON Schema evaluator.
 *
 * Validates structured agent output against a supplied schema. Unsupported
 * schema keywords are a *configuration error*, not a silent pass: ignoring
 * `patternProperties` (as JSON Schema's own rules require for unknown keywords)
 * would turn a strict format check into a rubber stamp.
 */

const schemaObject = z.record(z.string(), z.unknown());

export const jsonSchemaConfigSchema = z.strictObject({
  /** The JSON Schema (a supported subset — see json-schema.ts). */
  schema: schemaObject,
  /** Parse string output as JSON before validating (most agents reply with text). */
  parseJson: z.boolean().default(true),
  /** Cap on reported issues, so evidence stays bounded. */
  maxIssues: z.number().int().min(1).max(100).default(10),
});

export type JsonSchemaConfig = z.infer<typeof jsonSchemaConfigSchema>;

/** Extracts the first JSON object/array from text that may be fenced or chatty. */
export function extractJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { ok: false, error: "Output is empty" };
  }
  const direct = tryParse(trimmed);
  if (direct.ok) {
    return direct;
  }

  // Strip a fenced code block if present.
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1] !== undefined) {
    const fenced = tryParse(fence[1].trim());
    if (fenced.ok) {
      return fenced;
    }
  }

  // Fall back to the outermost braces/brackets.
  const start = trimmed.search(/[{[]/);
  if (start >= 0) {
    const open = trimmed[start];
    const close = open === "{" ? "}" : "]";
    const end = trimmed.lastIndexOf(close);
    if (end > start) {
      const sliced = tryParse(trimmed.slice(start, end + 1));
      if (sliced.ok) {
        return sliced;
      }
    }
  }
  return { ok: false, error: "Output is not valid JSON" };
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: "Output is not valid JSON" };
  }
}

export const jsonSchemaEvaluator: EvaluatorDefinition<JsonSchemaConfig> = {
  kind: "json_schema",
  label: "JSON Schema",
  description: "Validates structured output against a JSON Schema.",
  usesLlm: false,
  configSchema: jsonSchemaConfigSchema,
  configFields: [
    {
      name: "schema",
      label: "JSON Schema",
      type: "json",
      required: true,
      description: "Supported keywords: type, properties, required, items, enum, const, bounds, pattern, anyOf/allOf/oneOf/not.",
    },
    {
      name: "parseJson",
      label: "Parse output as JSON",
      type: "boolean",
      default: true,
      description: "Extract a JSON object from text output before validating.",
    },
  ],
  defaultConfig: {
    schema: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } },
    parseJson: true,
    maxIssues: 10,
  },

  async evaluate(input: EvaluationInput, _context, config): Promise<EvaluationOutcome> {
    const unsupported = unsupportedKeywords(config.schema);
    if (unsupported.length > 0) {
      throw new EvaluatorConfigInvalid(
        `This schema uses unsupported keyword(s): ${unsupported.join(", ")}. Rewrite it with the supported subset so validation stays strict.`,
      );
    }

    let candidate: unknown = input.output;
    if (config.parseJson && typeof candidate === "string") {
      const parsed = extractJson(candidate);
      if (!parsed.ok) {
        return {
          status: "COMPLETED",
          score: 0,
          maxScore: 1,
          passed: false,
          explanation: `${parsed.error} — the schema could not be checked.`,
          evidence: { parsed: false, outputPreview: preview(input.output, 400) },
        };
      }
      candidate = parsed.value;
    } else if (typeof candidate === "string") {
      const parsed = tryParse(candidate);
      if (parsed.ok) {
        candidate = parsed.value;
      }
    }

    const result = validateAgainstSchema(config.schema as JsonSchema, candidate, {
      maxIssues: config.maxIssues,
    });

    return {
      status: "COMPLETED",
      score: result.valid ? 1 : 0,
      maxScore: 1,
      passed: result.valid,
      explanation: result.valid
        ? "Output satisfies the JSON schema."
        : `Output violates the JSON schema: ${describeIssues(result.issues)}`,
      evidence: {
        valid: result.valid,
        issues: result.issues.map((issue: JsonSchemaIssue) => ({
          path: issue.path,
          keyword: issue.keyword,
          message: issue.message,
          actual: issue.actual,
        })),
        outputPreview: preview(toText(candidate), 400),
      },
    };
  },
};
