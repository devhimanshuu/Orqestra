import { z } from "zod";
import { SCORING_POLICIES } from "@/modules/evaluation/evaluation.types";
import { CASE_STATUSES } from "@/modules/evaluation/batch.types";
import { createRunSchema } from "@/modules/runtime/run.inputs";
import {
  EXPERIMENT_METRIC_KEYS,
  EXPERIMENT_ORDERINGS,
  EXPERIMENT_SELECTION_KINDS,
  EXPERIMENT_STATUSES,
} from "./experiment.types";

/**
 * Input contracts for experiment endpoints.
 *
 * Platform ceilings live here (and are enforced again in the service, because a
 * client's number is a request, not a decision): a configuration the platform
 * cannot run safely is refused before anything is sealed or scheduled.
 */

/** Candidate ceiling: baseline + challengers, on top of the agent and dataset. */
export const MAX_EXPERIMENT_CANDIDATES = 6;
/** Cases executed per experiment, after the dataset version is pinned. */
export const MAX_EXPERIMENT_CASES = 200;
/** Repeated trials per case (each replicate is its own sealed batch). */
export const MAX_EXPERIMENT_REPLICATES = 5;
/** Parallel executions across candidates. */
export const MAX_EXPERIMENT_CONCURRENCY = 5;
export const MAX_EXPERIMENT_EVALUATORS = 20;
/** Attempts per case, including the first (transient failures only). */
export const MAX_CASE_ATTEMPTS = 3;
export const DEFAULT_CASE_ATTEMPTS = 2;

export const experimentMetricSpecSchema = z.object({
  metric: z.enum(EXPERIMENT_METRIC_KEYS),
  direction: z.enum(["maximize", "minimize"]),
});

export const experimentObjectiveSchema = z.object({
  primary: experimentMetricSpecSchema,
  secondary: z.array(experimentMetricSpecSchema).max(6).default([]),
  notes: z.string().trim().max(1_000).nullable().default(null),
});

export const experimentConstraintsSchema = z.object({
  maxTotalCostUsd: z.number().min(0).max(10_000).nullable().default(null),
  maxMedianLatencyMs: z.number().int().min(1).max(3_600_000).nullable().default(null),
  minPassRate: z.number().min(0).max(1).nullable().default(null),
  minMeanScore: z.number().min(0).max(1).nullable().default(null),
  maxTotalTokens: z.number().int().min(1).max(1_000_000_000).nullable().default(null),
  maxToolCallsPerCase: z.number().min(0).max(1_000).nullable().default(null),
});

export const experimentCaseSelectionSchema = z.object({
  tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  caseKeys: z.array(z.string().trim().min(1).max(120)).max(MAX_EXPERIMENT_CASES).default([]),
  limit: z.number().int().min(1).max(MAX_EXPERIMENT_CASES).nullable().default(null),
});

export const experimentBudgetSchema = z.object({
  maxRuns: z.number().int().min(1).max(5_000).nullable().default(null),
  maxTotalTokens: z.number().int().min(1).max(1_000_000_000).nullable().default(null),
  maxCostUsd: z.number().min(0).max(10_000).nullable().default(null),
});

export const experimentExecutionSchema = z.object({
  concurrency: z.number().int().min(1).max(MAX_EXPERIMENT_CONCURRENCY).default(1),
  ordering: z.enum(EXPERIMENT_ORDERINGS).default("interleaved"),
  randomSeed: z.number().int().min(0).max(2_147_483_647).nullable().default(null),
  replicates: z.number().int().min(1).max(MAX_EXPERIMENT_REPLICATES).default(1),
  caseSelection: experimentCaseSelectionSchema.default({ tags: [], caseKeys: [], limit: null }),
  timeoutMs: z.number().int().min(1_000).max(3_600_000).nullable().default(null),
  limits: createRunSchema.shape.limits.nullable().default(null),
  retryPolicy: z.object({ maxAttempts: z.number().int().min(1).max(MAX_CASE_ATTEMPTS) }).default({
    maxAttempts: DEFAULT_CASE_ATTEMPTS,
  }),
  budget: experimentBudgetSchema.default({ maxRuns: null, maxTotalTokens: null, maxCostUsd: null }),
});

const candidateSelectionSchema = z.object({
  /** A published, immutable harness version. Never "latest". */
  harnessVersionId: z.string().min(1, "harnessVersionId is required"),
  label: z.string().trim().min(1).max(60).optional(),
  hypothesis: z.string().trim().max(1_000).nullable().optional(),
});

export const createExperimentSchema = z.object({
  projectId: z.string().min(1),
  agentId: z.string().min(1),
  name: z.string().trim().min(1, "Name is required").max(120),
  description: z.string().trim().max(1_000).nullable().optional(),
  hypothesis: z.string().trim().max(1_000).nullable().optional(),
  /** The control: exactly one baseline harness version. */
  baseline: candidateSelectionSchema,
  /** One or more challengers. */
  candidates: z
    .array(candidateSelectionSchema)
    .min(1, "Add at least one candidate to compare against the baseline")
    .max(MAX_EXPERIMENT_CANDIDATES - 1),
  datasetId: z.string().min(1, "datasetId is required"),
  /** Omit to pin the dataset's latest published version at launch time. */
  datasetVersionId: z.string().min(1).optional(),
  evaluators: z
    .array(
      z.object({
        evaluatorId: z.string().min(1),
        weight: z.number().min(0).max(1).optional(),
      }),
    )
    .min(1, "Select at least one evaluator")
    .max(MAX_EXPERIMENT_EVALUATORS),
  scoringPolicy: z.enum(SCORING_POLICIES).optional(),
  passThreshold: z.number().min(0).max(1).nullable().optional(),
  objective: experimentObjectiveSchema.optional(),
  constraints: experimentConstraintsSchema.optional(),
  execution: experimentExecutionSchema.optional(),
});

/** A draft can be edited freely; nothing is sealed until launch. */
export const updateExperimentSchema = createExperimentSchema
  .omit({ projectId: true })
  .partial();

export const listExperimentsQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(),
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
            .filter((entry): entry is (typeof EXPERIMENT_STATUSES)[number] =>
              (EXPERIMENT_STATUSES as readonly string[]).includes(entry),
            ) as Array<(typeof EXPERIMENT_STATUSES)[number]>),
    ),
  q: z.string().trim().max(120).optional(),
  sort: z.enum(["createdAt", "name", "status", "progress"]).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/**
 * Launching is the expensive, irreversible step, so the request must say so
 * explicitly: `confirm: true` is the API's equivalent of the wizard's review
 * checkbox, and a client that forgets it gets a 400 instead of a bill.
 */
export const launchExperimentSchema = z.object({
  confirm: z.literal(true, { error: "Launching an experiment must be confirmed explicitly" }),
});

export const selectCandidateSchema = z.object({
  candidateId: z.string().min(1),
  kind: z.enum(EXPERIMENT_SELECTION_KINDS).default("SELECTED"),
  notes: z.string().trim().max(1_000).optional(),
});

export const promoteCandidateSchema = z.object({
  /** Defaults to the candidate already selected on the experiment. */
  candidateId: z.string().min(1).optional(),
  /** Minimum pass rate the candidate must clear before the harness advances. */
  passRateThreshold: z.number().min(0).max(1).nullable().optional(),
  notes: z.string().trim().max(1_000).optional(),
});

export const compareExperimentQuerySchema = z.object({
  /** Defaults to the baseline candidate. */
  baselineCandidateId: z.string().min(1).optional(),
  /** Defaults to every non-baseline candidate. */
  candidateId: z.string().min(1).optional(),
  /** Include the per-case, side-by-side movement list. */
  includeCases: z
    .string()
    .optional()
    .transform((value) => value === "true" || value === "1"),
  /** Only cases that moved in the wrong direction. */
  regressionsOnly: z
    .string()
    .optional()
    .transform((value) => value === "true" || value === "1"),
});

export const experimentCasesQuerySchema = z.object({
  candidateId: z.string().min(1).optional(),
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

export const exportExperimentQuerySchema = z.object({
  format: z.enum(["json", "csv"]).default("json"),
  /** Restrict the per-case export to one candidate (default: every candidate). */
  candidateId: z.string().min(1).optional(),
});

export type CreateExperimentBody = z.infer<typeof createExperimentSchema>;
export type UpdateExperimentBody = z.infer<typeof updateExperimentSchema>;
export type ListExperimentsQuery = z.infer<typeof listExperimentsQuerySchema>;
export type LaunchExperimentBody = z.infer<typeof launchExperimentSchema>;
export type SelectCandidateBody = z.infer<typeof selectCandidateSchema>;
export type PromoteCandidateBody = z.infer<typeof promoteCandidateSchema>;
export type CompareExperimentQuery = z.infer<typeof compareExperimentQuerySchema>;
export type ExperimentCasesQuery = z.infer<typeof experimentCasesQuerySchema>;
export type ExportExperimentQuery = z.infer<typeof exportExperimentQuerySchema>;
export type ExperimentObjectiveInput = z.infer<typeof experimentObjectiveSchema>;
export type ExperimentConstraintsInput = z.infer<typeof experimentConstraintsSchema>;
export type ExperimentExecutionInput = z.infer<typeof experimentExecutionSchema>;
