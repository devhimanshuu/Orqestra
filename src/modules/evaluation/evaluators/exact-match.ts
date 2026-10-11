import { z } from "zod";
import type { EvaluationInput, EvaluationOutcome } from "../evaluation.types";
import { normalizeText, preview, toText, type EvaluatorDefinition } from "./contract";

/**
 * Exact match.
 *
 * Compares the final output with the expected answer after configurable
 * normalisation. Deterministic, no model involved: this is the evaluator a
 * dataset's `expectedOutput` is written for.
 *
 * Normalisation order (documented because it decides verdicts):
 *   1. line endings (CRLF → LF)
 *   2. whitespace runs → single space, blank lines collapsed
 *   3. trim
 *   4. lowercase (unless `caseSensitive`)
 */

export const exactMatchConfigSchema = z.strictObject({
  caseSensitive: z.boolean().default(false),
  normalizeWhitespace: z.boolean().default(true),
  normalizeLineEndings: z.boolean().default(true),
});

export type ExactMatchConfig = z.infer<typeof exactMatchConfigSchema>;

export const exactMatchEvaluator: EvaluatorDefinition<ExactMatchConfig> = {
  kind: "exact_match",
  label: "Exact match",
  description: "Compares the final output with the expected answer after normalisation.",
  usesLlm: false,
  configSchema: exactMatchConfigSchema,
  configFields: [
    { name: "caseSensitive", label: "Case sensitive", type: "boolean", default: false },
    {
      name: "normalizeWhitespace",
      label: "Normalise whitespace",
      type: "boolean",
      default: true,
      description: "Collapse runs of spaces and blank lines before comparing.",
    },
    {
      name: "normalizeLineEndings",
      label: "Normalise line endings",
      type: "boolean",
      default: true,
    },
  ],
  defaultConfig: { caseSensitive: false, normalizeWhitespace: true, normalizeLineEndings: true },

  async evaluate(input: EvaluationInput, _context, config): Promise<EvaluationOutcome> {
    const expected = input.expectedOutput;
    const usable = expected !== null && expected !== undefined && expected !== "";

    if (!usable) {
      // No reference answer: the evaluator cannot score this case. Returning a
      // 0 would be a fabrication, and the aggregate treats a missing score as
      // missing — never as a zero.
      return {
        status: "SKIPPED",
        explanation: "No expected output was provided for this case — nothing to compare against.",
        evidence: { reason: "missing_expected_output" },
      };
    }

    const options = {
      caseSensitive: config.caseSensitive,
      whitespace: config.normalizeWhitespace,
      lineEndings: config.normalizeLineEndings,
    };
    const actualText = toText(input.output);
    const expectedText = toText(expected);
    const actual = normalizeText(actualText, options);
    const expectedNormalized = normalizeText(expectedText, options);
    const matched = actual !== "" && actual === expectedNormalized;

    return {
      status: "COMPLETED",
      score: matched ? 1 : 0,
      maxScore: 1,
      passed: matched,
      explanation: matched
        ? "Output matches the expected answer exactly."
        : `Output does not match the expected answer. Expected "${preview(expectedText, 80)}" but got "${preview(actualText, 80)}".`,
      evidence: {
        matched,
        normalization: options,
        expected: preview(expectedText, 400),
        actual: preview(actualText, 400),
      },
    };
  },
};
