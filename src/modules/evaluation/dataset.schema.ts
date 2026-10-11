/**
 * Dataset contracts.
 *
 * A dataset is *user-uploaded data*, so everything here treats it as untrusted:
 *  - a bounded JSON value schema (nested depth and total serialised size are
 *    capped) — no `any`, no unbounded recursion, no executable content;
 *  - `caseKey` is an explicit stable identifier. It is what comparisons align
 *    on, so it is required (not derived from the case's position, which changes
 *    the moment a case is inserted);
 *  - imported files are validated as a whole and reported as a list of issues
 *    with paths, never as a first-error crash;
 *  - export uses the same shape import accepts, so a round trip is lossless.
 */

import { z } from "zod";

/** Platform ceilings — enforced on every import and every API write. */
export const MAX_DATASET_CASES = 1_000;
export const MAX_DATASET_JSON_BYTES = 512 * 1024;
export const MAX_CASE_JSON_BYTES = 128 * 1024;
export const MAX_CASE_KEY_LENGTH = 120;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const jsonPrimitive = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

/** Recursive JSON value schema (Zod's own laziness keeps TS types exact). */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([jsonPrimitive, z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
);

/** Measures the serialised size of a value; returns null when unmeasurable. */
export function jsonSizeBytes(value: unknown): number | null {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? null : Buffer.byteLength(text, "utf8");
  } catch {
    return null;
  }
}

const caseKeySchema = z
  .string()
  .min(1, "caseKey is required")
  .max(MAX_CASE_KEY_LENGTH)
  .regex(/^[A-Za-z0-9._:-]+$/, "caseKey may contain letters, digits, dot, underscore, colon and dash");

export const datasetCaseSchema = z.strictObject({
  caseKey: caseKeySchema,
  name: z.string().max(200).optional(),
  input: jsonValueSchema,
  expectedOutput: jsonValueSchema.optional(),
  metadata: z.record(z.string(), jsonValueSchema).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
});

export type DatasetCaseInput = z.infer<typeof datasetCaseSchema>;

export const datasetImportCaseSchema = datasetCaseSchema;

export const datasetImportSchema = z.strictObject({
  name: z.string().min(1).max(120),
  description: z.string().max(2_000).optional(),
  /** Optional original dataset identity, kept in the export for provenance. */
  datasetId: z.string().max(120).optional(),
  version: z.number().int().min(1).optional(),
  cases: z.array(datasetImportCaseSchema).min(1).max(MAX_DATASET_CASES),
});

export type DatasetImport = z.infer<typeof datasetImportSchema>;

export interface DatasetValidationIssue {
  path: string;
  message: string;
}

export type DatasetParseResult =
  | { ok: true; dataset: DatasetImport }
  | { ok: false; issues: DatasetValidationIssue[] };

function zodIssues(error: z.ZodError): DatasetValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message,
  }));
}

/**
 * Normalises the two accepted document shapes into the import contract:
 *
 *  - a plain import document `{ name, description?, cases }` (hand-written), or
 *  - an exported `orqestra.dataset` document
 *    `{ schemaVersion, exportedAt, dataset: {...}, cases }`.
 *
 * The wrapper is unwrapped here rather than loosened in the schema, so the
 * import contract stays strict (unknown keys are still rejected) while the
 * platform's own export file remains importable. The wrapper's provenance is
 * carried through as `datasetId`/`version`.
 */
export function normalizeImportDocument(value: unknown): {
  value: unknown;
  issues: DatasetValidationIssue[];
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { value, issues: [] };
  }
  const wrapper = value as Record<string, unknown>;
  const dataset = wrapper["dataset"];
  if (dataset === null || typeof dataset !== "object" || Array.isArray(dataset)) {
    return { value, issues: [] };
  }

  const issues: DatasetValidationIssue[] = [];
  const schemaVersion = wrapper["schemaVersion"];
  if (schemaVersion !== undefined && schemaVersion !== 1) {
    issues.push({
      path: "schemaVersion",
      message: `Unsupported dataset schemaVersion ${String(schemaVersion)} — expected 1`,
    });
  }

  const meta = dataset as Record<string, unknown>;
  const description = meta["description"];
  const id = meta["id"];
  const version = meta["version"];
  return {
    value: {
      name: meta["name"],
      ...(description !== undefined && description !== null ? { description } : {}),
      ...(typeof id === "string" ? { datasetId: id } : {}),
      ...(typeof version === "number" ? { version } : {}),
      cases: wrapper["cases"],
    },
    issues,
  };
}

/** Parses + validates an imported dataset document. Never throws. */
export function parseDatasetImport(value: unknown): DatasetParseResult {
  const normalized = normalizeImportDocument(value);
  value = normalized.value;
  const issues: DatasetValidationIssue[] = [...normalized.issues];

  const size = jsonSizeBytes(value);
  if (size !== null && size > MAX_DATASET_JSON_BYTES) {
    return {
      ok: false,
      issues: [
        {
          path: "(root)",
          message: `Dataset is ${Math.round(size / 1024)}KB, above the ${Math.round(MAX_DATASET_JSON_BYTES / 1024)}KB limit`,
        },
      ],
    };
  }

  // Structural problems that Zod cannot express are collected from the raw
  // value too, so an import report is complete rather than "first error only".
  const rawCases =
    value !== null && typeof value === "object" && Array.isArray((value as { cases?: unknown }).cases)
      ? (value as { cases: unknown[] }).cases
      : [];
  const seen = new Map<string, number>();
  rawCases.forEach((entry, index) => {
    const record = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : null;
    const caseKey = record?.["caseKey"];
    if (typeof caseKey === "string" && caseKey !== "") {
      const first = seen.get(caseKey);
      if (first !== undefined) {
        issues.push({
          path: `cases.${index}.caseKey`,
          message: `Duplicate caseKey "${caseKey}" (first used at cases.${first})`,
        });
      } else {
        seen.set(caseKey, index);
      }
    }
    const caseSize = jsonSizeBytes(entry);
    if (caseSize !== null && caseSize > MAX_CASE_JSON_BYTES) {
      issues.push({
        path: `cases.${index}`,
        message: `Test case is ${Math.round(caseSize / 1024)}KB, above the ${Math.round(MAX_CASE_JSON_BYTES / 1024)}KB limit`,
      });
    }
  });

  const parsed = datasetImportSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, issues: [...zodIssues(parsed.error), ...issues] };
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, dataset: parsed.data };
}

export interface DatasetCaseRecord {
  caseKey: string;
  name: string | null;
  input: JsonValue;
  expectedOutput: JsonValue | null;
  metadata: Record<string, JsonValue> | null;
  tags: string[];
}

/** Serialises a stored case into the export/import shape. */
export function toExportCase(record: DatasetCaseRecord): Record<string, unknown> {
  return {
    caseKey: record.caseKey,
    ...(record.name !== null ? { name: record.name } : {}),
    input: record.input,
    ...(record.expectedOutput !== null ? { expectedOutput: record.expectedOutput } : {}),
    ...(record.metadata !== null ? { metadata: record.metadata } : {}),
    ...(record.tags.length > 0 ? { tags: record.tags } : {}),
  };
}

export interface DatasetExportDocument {
  schemaVersion: 1;
  exportedAt: string;
  dataset: {
    id: string;
    name: string;
    description: string | null;
    version: number;
    caseCount: number;
  };
  cases: Array<Record<string, unknown>>;
}

/** Builds the export document. The same file is accepted by `parseDatasetImport`. */
export function buildDatasetExport(input: {
  id: string;
  name: string;
  description: string | null;
  version: number;
  cases: readonly DatasetCaseRecord[];
  now: Date;
}): DatasetExportDocument {
  return {
    schemaVersion: 1,
    exportedAt: input.now.toISOString(),
    dataset: {
      id: input.id,
      name: input.name,
      description: input.description,
      version: input.version,
      caseCount: input.cases.length,
    },
    cases: input.cases.map(toExportCase),
  };
}
