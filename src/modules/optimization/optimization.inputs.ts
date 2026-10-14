import { z } from "zod";
import { SCORING_POLICIES } from "@/modules/evaluation/evaluation.types";
import { EXPERIMENT_METRIC_KEYS } from "@/modules/experiments/experiment.types";
import {
  DEFAULT_OPTIMIZATION_LIMITS,
  OPTIMIZATION_STATUSES,
  OPTIMIZATION_STRATEGIES,
} from "./optimization.types";

/**
 * Input contracts for optimization endpoints.
 *
 * Platform ceilings live here and are enforced again in the service: a client's
 * number is a request, not a decision. A configuration the loop cannot run
 * safely is refused before anything is sealed or a job is enqueued.
 */

/** Iterations the loop may run, whatever a session asks for. */
export const MAX_OPTIMIZATION_ITERATIONS = 10;
/** Candidates a single iteration may create. */
export const MAX_CANDIDATES_PER_ITERATION = 3;
/** Candidates a whole session may create. */
export const MAX_SESSION_CANDIDATES = 20;
/** Agent runs a whole session may create (across every candidate evaluation). */
export const MAX_SESSION_RUNS = 500;

export const optimizationMetricSpecSchema = z.object({
  metric: z.enum(EXPERIMENT_METRIC_KEYS),
  direction: z.enum(["maximize", "minimize"]),
});

export const optimizationObjectiveSchema = z.object({
  primary: optimizationMetricSpecSchema,
  secondary: z.array(optimizationMetricSpecSchema).max(6).default([]),
  /** Improvement the primary metric must show to count as a win, as a fraction. */
  minImprovementPct: z.number().min(0).max(10).default(0),
  notes: z.string().trim().max(1_000).nullable().default(null),
});

export const optimizationConstraintsSchema = z.object({
  /** Floors on the candidate's own measurements. */
  minPassRate: z.number().min(0).max(1).nullable().default(null),
  minMeanScore: z.number().min(0).max(1).nullable().default(null),
  /** Ceilings on the candidate's own measurements. */
  maxMedianLatencyMs: z.number().int().min(1).max(3_600_000).nullable().default(null),
  maxTotalTokens: z.number().int().min(1).max(1_000_000_000).nullable().default(null),
  maxTotalCostUsd: z.number().min(0).max(10_000).nullable().default(null),
  /** Relative regressions versus the baseline, as fractions (0.2 = +20%). */
  maxCostIncreasePct: z.number().min(0).max(10).nullable().default(null),
  maxLatencyIncreasePct: z.number().min(0).max(10).nullable().default(null),
  /** Allowed drop of the primary metric versus the baseline (fraction). */
  maxQualityRegressionPct: z.number().min(0).max(1).nullable().default(null),
});

export const optimizationLimitsSchema = z.object({
  maxIterations: z
    .number()
    .int()
    .min(1)
    .max(MAX_OPTIMIZATION_ITERATIONS)
    .default(DEFAULT_OPTIMIZATION_LIMITS.maxIterations),
  maxCandidatesPerIteration: z
    .number()
    .int()
    .min(1)
    .max(MAX_CANDIDATES_PER_ITERATION)
    .default(DEFAULT_OPTIMIZATION_LIMITS.maxCandidatesPerIteration),
  maxCandidates: z
    .number()
    .int()
    .min(1)
    .max(MAX_SESSION_CANDIDATES)
    .default(DEFAULT_OPTIMIZATION_LIMITS.maxCandidates),
  maxRuns: z.number().int().min(1).max(MAX_SESSION_RUNS).default(DEFAULT_OPTIMIZATION_LIMITS.maxRuns),
  maxTotalTokens: z.number().int().min(1).max(1_000_000_000).nullable().default(null),
  maxCostUsd: z.number().min(0).max(10_000).nullable().default(null),
  maxElapsedMs: z.number().int().min(1_000).max(86_400_000).nullable().default(null),
  maxConsecutiveInvalid: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(DEFAULT_OPTIMIZATION_LIMITS.maxConsecutiveInvalid),
  stallIterations: z.number().int().min(1).max(10).default(DEFAULT_OPTIMIZATION_LIMITS.stallIterations),
  requireApprovalBeforeEvaluation: z.boolean().default(false),
  /** "provider:model" the LLM-assisted strategy may call; null disables it. */
  analyzerModel: z
    .string()
    .trim()
    .min(3)
    .max(120)
    .regex(/^[\w.-]+:[\w.-]+$/, 'Expected a "provider:model" reference')
    .nullable()
    .default(null),
});

export const createOptimizationSessionSchema = z.object({
  projectId: z.string().min(1),
  agentId: z.string().min(1),
  name: z.string().trim().min(1, "Name is required").max(120),
  description: z.string().trim().max(1_000).nullable().optional(),
  /** The immutable baseline version every candidate is measured against. */
  baselineVersionId: z.string().min(1, "baselineVersionId is required"),
  /** The real batch whose failures seed the analysis. */
  sourceBatchId: z.string().min(1, "sourceBatchId is required"),
  strategy: z.enum(OPTIMIZATION_STRATEGIES).default("RULE_BASED"),
  objective: optimizationObjectiveSchema.optional(),
  constraints: optimizationConstraintsSchema.optional(),
  limits: optimizationLimitsSchema.optional(),
  /** Require an explicit human approval before a candidate is promoted. */
  requireApproval: z.boolean().default(true),
});

export const updateOptimizationSessionSchema = createOptimizationSessionSchema
  .omit({ projectId: true })
  .partial();

export const listOptimizationSessionsQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  status: z
    .string()
    .optional()
    .transform((value) =>
      value === undefined || value === ""
        ? undefined
        : (value
            .split(",")
            .map((entry) => entry.trim().toUpperCase())
            .filter((entry): entry is (typeof OPTIMIZATION_STATUSES)[number] =>
              (OPTIMIZATION_STATUSES as readonly string[]).includes(entry),
            ) as Array<(typeof OPTIMIZATION_STATUSES)[number]>),
    ),
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/** Starting is the expensive step: it must be confirmed explicitly. */
export const startOptimizationSessionSchema = z.object({
  confirm: z.literal(true, { error: "Starting an optimization must be confirmed explicitly" }),
});

export const cancelOptimizationSessionSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const approveCandidateSchema = z.object({
  /** Notes recorded with the approval. */
  notes: z.string().trim().max(1_000).optional(),
});

export const rejectCandidateSchema = z.object({
  reason: z.string().trim().min(1, "A rejection needs a reason").max(1_000),
});

export const promoteOptimizationCandidateSchema = z.object({
  /** Defaults to the session's best accepted candidate. */
  candidateId: z.string().min(1).optional(),
  notes: z.string().trim().max(1_000).optional(),
  /**
   * Explicitly promote a candidate the policy did not accept. The override must
   * carry a reason: the platform then records that a human accepted a known
   * trade-off instead of claiming evidence it does not have.
   */
  override: z.boolean().default(false),
  reason: z.string().trim().min(1).max(1_000).optional(),
});

/** Attach a manually edited candidate (Strategy 3) to a running session. */
export const attachManualCandidateSchema = z.object({
  /** A harness version the developer published from the builder. */
  harnessVersionId: z.string().min(1),
  label: z.string().trim().min(1).max(60).optional(),
  notes: z.string().trim().max(1_000).optional(),
});

export const optimizationCandidatesQuerySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((value) =>
      value === undefined || value === ""
        ? undefined
        : value
            .split(",")
            .map((entry) => entry.trim().toUpperCase())
            .filter((entry) => entry.length > 0),
    ),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const optimizationEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/** Cross-session history scope. `since` bounds the window the history compares. */
export const optimizationHistoryQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
  since: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const exportOptimizationReportSchema = z.object({
  format: z.enum(["json", "markdown"]).default("json"),
});

export const scoringPolicySchema = z.enum(SCORING_POLICIES);

export type CreateOptimizationSessionBody = z.infer<typeof createOptimizationSessionSchema>;
export type UpdateOptimizationSessionBody = z.infer<typeof updateOptimizationSessionSchema>;
export type ListOptimizationSessionsQuery = z.infer<typeof listOptimizationSessionsQuerySchema>;
export type StartOptimizationSessionBody = z.infer<typeof startOptimizationSessionSchema>;
export type CancelOptimizationSessionBody = z.infer<typeof cancelOptimizationSessionSchema>;
export type ApproveCandidateBody = z.infer<typeof approveCandidateSchema>;
export type RejectCandidateBody = z.infer<typeof rejectCandidateSchema>;
export type PromoteOptimizationCandidateBody = z.infer<typeof promoteOptimizationCandidateSchema>;
export type AttachManualCandidateBody = z.infer<typeof attachManualCandidateSchema>;
export type OptimizationObjectiveInput = z.infer<typeof optimizationObjectiveSchema>;
export type OptimizationConstraintsInput = z.infer<typeof optimizationConstraintsSchema>;
export type OptimizationLimitsInput = z.infer<typeof optimizationLimitsSchema>;
export type OptimizationHistoryQuery = z.infer<typeof optimizationHistoryQuerySchema>;
