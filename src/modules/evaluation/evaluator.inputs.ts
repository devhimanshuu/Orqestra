import { z } from "zod";
import { EVALUATOR_KINDS } from "./evaluation.types";

/**
 * Input contracts for evaluator configuration endpoints.
 *
 * `kind` is one of the built-in evaluator kinds, and `config` is validated
 * against that kind's strict schema by the service (via the evaluator
 * registry) — so a typo in a config key is rejected at configuration time
 * rather than silently ignored at scoring time.
 */

export const evaluatorKindSchema = z.enum(EVALUATOR_KINDS);

export const createEvaluatorSchema = z.object({
  projectId: z.string().min(1, "projectId is required"),
  name: z.string().trim().min(1, "Name is required").max(120),
  description: z.string().trim().max(2_000).optional(),
  slug: z.string().trim().max(60).optional(),
  kind: evaluatorKindSchema,
  /** Kind-specific configuration; omitted → the kind's default. */
  config: z.record(z.string(), z.unknown()).optional(),
  /** Default weight in a batch. 0 means "equal weighting". */
  weight: z.number().min(0).max(1).optional(),
});

export const updateEvaluatorSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2_000).nullable().optional(),
  enabled: z.boolean().optional(),
  /** Providing a config creates a new immutable revision. */
  config: z.record(z.string(), z.unknown()).optional(),
  weight: z.number().min(0).max(1).optional(),
});

export const validateEvaluatorConfigSchema = z.object({
  kind: evaluatorKindSchema,
  config: z.record(z.string(), z.unknown()).optional(),
});

export const listEvaluatorsQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  kind: evaluatorKindSchema.optional(),
  enabledOnly: z
    .string()
    .optional()
    .transform((value) => value === "true" || value === "1"),
});

export type CreateEvaluatorBody = z.infer<typeof createEvaluatorSchema>;
export type UpdateEvaluatorBody = z.infer<typeof updateEvaluatorSchema>;
export type ValidateEvaluatorConfigBody = z.infer<typeof validateEvaluatorConfigSchema>;
export type ListEvaluatorsQuery = z.infer<typeof listEvaluatorsQuerySchema>;
