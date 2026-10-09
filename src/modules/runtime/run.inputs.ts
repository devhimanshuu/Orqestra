import { z } from "zod";
import { RUN_STATUSES } from "./run.types";

/**
 * Input contracts for run endpoints.
 *
 * The server never trusts ids, statuses or limits from the client: the service
 * re-resolves ownership from the database and clamps every limit.
 */

export const createRunSchema = z.object({
  agentId: z.string().min(1, "agentId is required"),
  harnessVersionId: z.string().min(1, "harnessVersionId is required"),
  input: z.string().min(1, "Provide a task for the agent").max(20_000),
  /** Optional budget overrides — clamped to platform ceilings by the service. */
  limits: z
    .object({
      maxDurationMs: z.number().int().min(1_000).max(3_600_000).optional(),
      maxNodes: z.number().int().min(1).max(10_000).optional(),
      maxIterations: z.number().int().min(1).max(1_000).optional(),
      maxToolCalls: z.number().int().min(0).max(10_000).optional(),
      maxLlmCalls: z.number().int().min(0).max(10_000).optional(),
      maxCostUsd: z.number().min(0).max(1_000).nullable().optional(),
    })
    .optional(),
});

export type CreateRunBody = z.infer<typeof createRunSchema>;

export const listRunsQuerySchema = z.object({
  agentId: z.string().min(1).optional(),
  harnessId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  status: z
    .string()
    .optional()
    .transform((value) =>
      value === undefined || value === ""
        ? undefined
        : (value
            .split(",")
            .map((entry) => entry.trim().toUpperCase())
            .filter((entry): entry is (typeof RUN_STATUSES)[number] =>
              (RUN_STATUSES as readonly string[]).includes(entry),
            ) as Array<(typeof RUN_STATUSES)[number]>),
    ),
  /** ISO date; runs created on/after this instant. */
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export type ListRunsQuery = z.infer<typeof listRunsQuerySchema>;

export const runPreviewQuerySchema = z.object({
  harnessVersionId: z.string().min(1).optional(),
});
