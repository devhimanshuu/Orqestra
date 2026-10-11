import { z } from "zod";
import { MAX_DATASET_CASES, datasetCaseSchema } from "./dataset.schema";

/**
 * Input contracts for dataset endpoints.
 *
 * Every id, case and tag is re-validated on the server; the client's shape is
 * a request, never a fact. Imported documents go through
 * `parseDatasetImport()`, which produces a *list* of issues rather than a
 * first-error crash.
 */

export const createDatasetSchema = z.object({
  projectId: z.string().min(1, "projectId is required"),
  name: z.string().trim().min(1, "Name is required").max(120),
  description: z.string().trim().max(2_000).optional(),
  slug: z.string().trim().max(60).optional(),
  /** Optional initial cases (same shape as import). */
  cases: z.array(datasetCaseSchema).max(MAX_DATASET_CASES).optional(),
});

export const updateDatasetSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2_000).nullable().optional(),
});

/** A case body: `caseKey` is required on create, immutable afterwards. */
export const datasetCaseBodySchema = datasetCaseSchema;

export const datasetCaseUpdateSchema = z
  .object({
    name: z.string().trim().max(200).nullable().optional(),
    input: datasetCaseSchema.shape.input.optional(),
    expectedOutput: datasetCaseSchema.shape.expectedOutput.optional(),
    metadata: datasetCaseSchema.shape.metadata.optional(),
    tags: datasetCaseSchema.shape.tags.optional(),
  })
  .strict();

export const importDatasetBodySchema = z.object({
  projectId: z.string().min(1, "projectId is required"),
  /** Raw parsed JSON. Validated by parseDatasetImport(), not by Zod. */
  document: z.unknown(),
  /**
   * `create` always makes a new dataset; `replace` overwrites the working set
   * of an existing dataset (its versions and batches are untouched).
   */
  mode: z.enum(["create", "replace"]).default("create"),
  datasetId: z.string().min(1).optional(),
});

export const listDatasetsQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  q: z.string().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const publishDatasetVersionSchema = z.object({
  /** Optional label for the version (defaults to the dataset name). */
  name: z.string().trim().max(120).optional(),
});

export const exportDatasetQuerySchema = z.object({
  /** Export a published version instead of the working set. */
  version: z.coerce.number().int().min(1).optional(),
});

export type CreateDatasetBody = z.infer<typeof createDatasetSchema>;
export type UpdateDatasetBody = z.infer<typeof updateDatasetSchema>;
export type DatasetCaseBody = z.infer<typeof datasetCaseBodySchema>;
export type DatasetCaseUpdateBody = z.infer<typeof datasetCaseUpdateSchema>;
export type ImportDatasetBody = z.infer<typeof importDatasetBodySchema>;
export type ListDatasetsQuery = z.infer<typeof listDatasetsQuerySchema>;
export type PublishDatasetVersionBody = z.infer<typeof publishDatasetVersionSchema>;
export type ExportDatasetQuery = z.infer<typeof exportDatasetQuerySchema>;
