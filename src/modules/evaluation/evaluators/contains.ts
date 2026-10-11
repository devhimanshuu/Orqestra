import { z } from "zod";
import type { EvaluationInput, EvaluationOutcome } from "../evaluation.types";
import { normalizeText, preview, toText, type EvaluatorDefinition } from "./contract";

/**
 * Contains / keyword evaluator.
 *
 * Checks required phrases are present and prohibited phrases are absent. The
 * score is graded — the fraction of required phrases found — unless a
 * prohibited phrase appears, which is a hard failure: a run that says the
 * forbidden thing is not "75% correct".
 */

export const containsConfigSchema = z
  .strictObject({
    required: z.array(z.string().min(1).max(500)).max(50).default([]),
    prohibited: z.array(z.string().min(1).max(500)).max(50).default([]),
    caseSensitive: z.boolean().default(false),
    normalizeWhitespace: z.boolean().default(true),
  })
  .refine((config) => config.required.length + config.prohibited.length > 0, {
    message: "Configure at least one required or prohibited phrase",
    path: ["required"],
  });

export type ContainsConfig = z.infer<typeof containsConfigSchema>;

export const containsEvaluator: EvaluatorDefinition<ContainsConfig> = {
  kind: "contains",
  label: "Contains / keywords",
  description: "Checks that required phrases appear and prohibited phrases do not.",
  usesLlm: false,
  configSchema: containsConfigSchema,
  configFields: [
    {
      name: "required",
      label: "Required phrases",
      type: "string[]",
      description: "Every phrase must appear in the output.",
    },
    {
      name: "prohibited",
      label: "Prohibited phrases",
      type: "string[]",
      description: "The output must not contain any of these — a hard failure.",
    },
    { name: "caseSensitive", label: "Case sensitive", type: "boolean", default: false },
  ],
  defaultConfig: { required: [], prohibited: [], caseSensitive: false, normalizeWhitespace: true },

  async evaluate(input: EvaluationInput, _context, config): Promise<EvaluationOutcome> {
    const options = {
      caseSensitive: config.caseSensitive,
      whitespace: config.normalizeWhitespace,
      lineEndings: true,
    };
    const haystack = normalizeText(toText(input.output), options);

    const normalizePhrase = (phrase: string): string => normalizeText(phrase, options);
    const missing = config.required.filter((phrase) => !haystack.includes(normalizePhrase(phrase)));
    const foundProhibited = config.prohibited.filter((phrase) =>
      haystack.includes(normalizePhrase(phrase)),
    );
    const foundRequired = config.required.length - missing.length;
    const ratio = config.required.length === 0 ? 1 : foundRequired / config.required.length;
    const passed = missing.length === 0 && foundProhibited.length === 0;
    const score = foundProhibited.length > 0 ? 0 : ratio;

    const parts: string[] = [];
    if (config.required.length > 0) {
      parts.push(`${foundRequired}/${config.required.length} required phrase(s) present`);
    }
    if (missing.length > 0) {
      parts.push(`missing: ${missing.map((phrase) => `"${preview(phrase, 40)}"`).join(", ")}`);
    }
    if (foundProhibited.length > 0) {
      parts.push(
        `forbidden phrase(s) found: ${foundProhibited
          .map((phrase) => `"${preview(phrase, 40)}"`)
          .join(", ")}`,
      );
    }
    if (parts.length === 0) {
      parts.push("No phrases configured.");
    }

    return {
      status: "COMPLETED",
      score,
      maxScore: 1,
      passed,
      explanation: `${parts.join(" · ")}.`,
      evidence: {
        requiredConfigured: config.required,
        missing,
        prohibitedFound: foundProhibited,
        outputPreview: preview(input.output, 400),
      },
    };
  },
};
