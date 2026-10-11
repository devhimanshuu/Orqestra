import { z } from "zod";
import { createRunSchema } from "@/modules/runtime/run.inputs";
import { BATCH_STATUSES, CASE_STATUSES } from "./batch.types";
import { SCORING_POLICIES } from "./evaluation.types";

/**
 * Input contracts for evaluation endpoints.
 *
 * Concurrency and budgets are clamped here *and* in the service: the client's
 * number is a request, the platform ceiling wins.
 */

/** Platform ceiling on parallel case execution per batch. */
export const MAX_BATCH_CONCURRENCY = 5;
/** Platform ceiling on evaluators attached to one batch. */
export const MAX_BATCH_EVALUATORS = 20;

const evaluatorSelectionSchema = z.object({
  evaluatorId: z.string().min(1),
  /** Optional override of the evaluator's default weight. */
  weight: z.number().min(0).max(1).optional(),
});

export const startEvaluationSchema = z.object({
  agentId: z.string().min(1, "agentId is required"),
  harnessVersionId: z.string().min(1, "harnessVersionId is required"),
  datasetId: z.string().min(1, "datasetId is required"),
  /** Omit to pin the dataset's latest published version. */
  datasetVersionId: z.string().min(1).optional(),
  label: z.string().trim().max(120).optional(),
  evaluators: z
    .array(evaluatorSelectionSchema)
    .min(1, "Select at least one evaluator")
    .max(MAX_BATCH_EVALUATORS),
  scoringPolicy: z.enum(SCORING_POLICIES).optional(),
  passThreshold: z.number().min(0).max(1).nullable().optional(),
  concurrency: z.number().int().min(1).max(MAX_BATCH_CONCURRENCY).optional(),
  /** Per-case runtime budget overrides (clamped again by the run service). */
  limits: createRunSchema.shape.limits.optional(),
});

export const listBatchesQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  harnessId: z.string().min(1).optional(),
  datasetId: z.string().min(1).optional(),
  status: z
    .string()
    .optional()
    .transform((value) =>
      value === undefined || value === ""
        ? undefined
        : (value
            .split(",")
            .map((entry) => entry.trim().toUpperCase())
            .filter((entry): entry is (typeof BATCH_STATUSES)[number] =>
              (BATCH_STATUSES as readonly string[]).includes(entry),
            ) as Array<(typeof BATCH_STATUSES)[number]>),
    ),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const listCasesQuerySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((value) =>
      value === undefined || value === ""
        ? undefined
        : (value
            .split(",")
            .map((entry) => entry.trim().toUpperCase())
            .filter((entry): entry is (typeof CASE_STATUSES)[number] =>
              (CASE_STATUSES as readonly string[]).includes(entry),
            ) as Array<(typeof CASE_STATUSES)[number]>),
    ),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const compareBatchesQuerySchema = z.object({
  baseline: z.string().min(1, "baseline is required"),
  candidate: z.string().min(1, "candidate is required"),
  /** Include the per-case movement list in the response. */
  includeCases: z
    .string()
    .optional()
    .transform((value) => value === "true" || value === "1"),
});

export const evaluateRunSchema = z.object({
  evaluators: z
    .array(evaluatorSelectionSchema)
    .min(1, "Select at least one evaluator")
    .max(10, "Evaluate a single run with at most 10 evaluators"),
  scoringPolicy: z.enum(SCORING_POLICIES).optional(),
  passThreshold: z.number().min(0).max(1).nullable().optional(),
});

export type StartEvaluationBody = z.infer<typeof startEvaluationSchema>;
export type ListBatchesQuery = z.infer<typeof listBatchesQuerySchema>;
export type ListCasesQuery = z.infer<typeof listCasesQuerySchema>;
export type CompareBatchesQuery = z.infer<typeof compareBatchesQuerySchema>;
export type EvaluateRunBody = z.infer<typeof evaluateRunSchema>;
