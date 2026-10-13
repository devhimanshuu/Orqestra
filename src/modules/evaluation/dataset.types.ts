import type { JsonValue } from "./dataset.schema";

/**
 * Dataset domain types.
 *
 * Two layers, mirroring harness draft/version:
 *
 *   Dataset            mutable shell (name, description, currentVersion)
 *    ├── DatasetCase[] mutable working set (what the editor edits)
 *    └── DatasetVersion  immutable, content-hashed snapshot (what a batch pins)
 */

export interface Dataset {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  description: string | null;
  currentVersion: number;
  caseCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface DatasetCase {
  id: string;
  datasetId: string;
  caseKey: string;
  name: string | null;
  input: JsonValue;
  expectedOutput: JsonValue | null;
  metadata: Record<string, JsonValue> | null;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface DatasetVersion {
  id: string;
  datasetId: string;
  version: number;
  name: string;
  caseCount: number;
  contentHash: string;
  createdBy: string | null;
  createdAt: Date;
}

/** List projection: dataset + how many versions/batches hang off it. */
export interface DatasetSummary extends Dataset {
  versionCount: number;
  batchCount: number;
}

export interface DatasetWithCases extends Dataset {
  cases: DatasetCase[];
  versions: DatasetVersion[];
}

/** The immutable case snapshot stored inside a DatasetVersion. */
export interface DatasetCaseSnapshot {
  caseKey: string;
  name: string | null;
  input: JsonValue;
  expectedOutput: JsonValue | null;
  metadata: Record<string, JsonValue> | null;
  tags: string[];
}

export class DatasetNotFoundError extends Error {
  constructor(datasetId: string) {
    super(`Dataset "${datasetId}" not found`);
    this.name = "DatasetNotFoundError";
  }
}

export class DatasetConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatasetConflictError";
  }
}

export class DatasetInUseError extends Error {
  constructor(datasetId: string, batchCount: number, experimentCount = 0) {
    super(
      `This dataset has ${batchCount} evaluation batch${batchCount === 1 ? "" : "es"} and ${experimentCount} experiment${experimentCount === 1 ? "" : "s"} pinned to it. Delete those first, or keep the dataset — deleting it would erase the meaning of their results.`,
    );
    this.name = "DatasetInUseError";
  }
}
