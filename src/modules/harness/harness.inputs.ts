import { z } from "zod";
import { harnessDraftDocumentSchema } from "./harness.schema";

/**
 * Input contracts for harness operations.
 *
 * Route handlers pass raw JSON; services parse with these schemas, so the
 * server re-validates everything the editor claims — node ids, edge ids, node
 * types, configuration, versions and slugs are never trusted from a client.
 */

export const createHarnessSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  description: z.string().trim().max(500).optional(),
  slug: z.string().trim().max(60).optional(),
  definition: harnessDraftDocumentSchema.optional(),
});

export const updateHarnessSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  /** ARCHIVED hides the harness from pickers; DRAFT restores it (revalidated). */
  status: z.enum(["ARCHIVED", "DRAFT"]).optional(),
});

export const saveDraftSchema = z.object({
  definition: harnessDraftDocumentSchema,
});

export const publishVersionSchema = z.object({
  definition: harnessDraftDocumentSchema.optional(),
  releaseNotes: z.string().trim().max(1000).optional(),
});

export const duplicateHarnessSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  sourceVersionId: z.string().min(1).optional(),
});

export const validateDefinitionSchema = z.object({
  definition: harnessDraftDocumentSchema,
});

export const exportHarnessQuerySchema = z.object({
  version: z.coerce.number().int().min(1).optional(),
});

export const harnessExportDocumentSchema = z.object({
  format: z.literal("orqestra.harness"),
  exportedAt: z.string().optional(),
  harness: z.object({
    name: z.string().trim().min(1).max(80),
    description: z.string().max(500).nullable().optional(),
    slug: z.string().max(60).optional(),
  }),
  version: z.number().int().min(1).nullable().optional(),
  releaseNotes: z.string().max(1000).nullable().optional(),
  definition: harnessDraftDocumentSchema,
});

export const importHarnessSchema = z.object({
  agentId: z.string().min(1),
  document: harnessExportDocumentSchema,
});
