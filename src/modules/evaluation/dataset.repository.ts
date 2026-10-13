import { Prisma } from "@/generated/prisma/client";
import { getPrisma } from "@/lib/db/prisma";
import type {
  Dataset,
  DatasetCase,
  DatasetCaseSnapshot,
  DatasetSummary,
  DatasetVersion,
} from "./dataset.types";

/**
 * Dataset persistence.
 *
 * Working-set writes are transactional with the denormalised `caseCount`, so a
 * list never shows a count that does not match its cases. Versions are
 * write-once: `publishVersion` inserts a snapshot and advances
 * `currentVersion` in one transaction, and nothing ever updates a snapshot.
 */

function asJson(value: unknown): Prisma.InputJsonValue {
  return (value === undefined ? null : value) as Prisma.InputJsonValue;
}

function toCase(row: {
  id: string;
  datasetId: string;
  caseKey: string;
  name: string | null;
  input: Prisma.JsonValue;
  expectedOutput: Prisma.JsonValue | null;
  metadata: Prisma.JsonValue | null;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}): DatasetCase {
  return {
    id: row.id,
    datasetId: row.datasetId,
    caseKey: row.caseKey,
    name: row.name,
    input: row.input as DatasetCase["input"],
    expectedOutput: (row.expectedOutput ?? null) as DatasetCase["expectedOutput"],
    metadata:
      row.metadata !== null && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, never>)
        : null,
    tags: row.tags,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDataset(row: {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  description: string | null;
  currentVersion: number;
  caseCount: number;
  createdAt: Date;
  updatedAt: Date;
}): Dataset {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    slug: row.slug,
    description: row.description,
    currentVersion: row.currentVersion,
    caseCount: row.caseCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toVersion(row: {
  id: string;
  datasetId: string;
  version: number;
  name: string;
  caseCount: number;
  contentHash: string;
  createdBy: string | null;
  createdAt: Date;
}): DatasetVersion {
  return {
    id: row.id,
    datasetId: row.datasetId,
    version: row.version,
    name: row.name,
    caseCount: row.caseCount,
    contentHash: row.contentHash,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

/** Snapshot cases as stored in `DatasetVersion.cases`. */
export function parseCaseSnapshot(value: Prisma.JsonValue): DatasetCaseSnapshot[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    return {
      caseKey: typeof record["caseKey"] === "string" ? record["caseKey"] : "",
      name: typeof record["name"] === "string" ? record["name"] : null,
      input: record["input"] as DatasetCaseSnapshot["input"],
      expectedOutput: (record["expectedOutput"] ?? null) as DatasetCaseSnapshot["expectedOutput"],
      metadata:
        record["metadata"] !== null &&
        typeof record["metadata"] === "object" &&
        !Array.isArray(record["metadata"])
          ? (record["metadata"] as Record<string, never>)
          : null,
      tags: Array.isArray(record["tags"])
        ? record["tags"].filter((tag): tag is string => typeof tag === "string")
        : [],
    };
  });
}

export const datasetRepository = {
  async findById(datasetId: string): Promise<Dataset | null> {
    const row = await getPrisma().dataset.findUnique({ where: { id: datasetId } });
    return row ? toDataset(row) : null;
  },

  async findBySlug(projectId: string, slug: string): Promise<Dataset | null> {
    const row = await getPrisma().dataset.findUnique({
      where: { projectId_slug: { projectId, slug } },
    });
    return row ? toDataset(row) : null;
  },

  async listByProject(projectId: string): Promise<DatasetSummary[]> {
    const rows = await getPrisma().dataset.findMany({
      where: { projectId },
      orderBy: { updatedAt: "desc" },
      include: { _count: { select: { versions: true, batches: true } } },
    });
    return rows.map((row) => ({
      ...toDataset(row),
      versionCount: row._count.versions,
      batchCount: row._count.batches,
    }));
  },

  async listByProjects(projectIds: string[]): Promise<Dataset[]> {
    const rows = await getPrisma().dataset.findMany({
      where: { projectId: { in: projectIds } },
      orderBy: { updatedAt: "desc" },
    });
    return rows.map(toDataset);
  },

  async findWithCases(datasetId: string): Promise<{
    dataset: Dataset;
    cases: DatasetCase[];
    versions: DatasetVersion[];
  } | null> {
    const row = await getPrisma().dataset.findUnique({
      where: { id: datasetId },
      include: {
        cases: { orderBy: { caseKey: "asc" } },
        versions: { orderBy: { version: "desc" } },
      },
    });
    if (row === null) {
      return null;
    }
    return {
      dataset: toDataset(row),
      cases: row.cases.map(toCase),
      versions: row.versions.map(toVersion),
    };
  },

  async create(input: {
    projectId: string;
    name: string;
    slug: string;
    description?: string | null;
    cases: DatasetCaseSnapshot[];
  }): Promise<Dataset> {
    const row = await getPrisma().dataset.create({
      data: {
        projectId: input.projectId,
        name: input.name,
        slug: input.slug,
        description: input.description,
        caseCount: input.cases.length,
        cases: {
          create: input.cases.map((entry) => ({
            caseKey: entry.caseKey,
            name: entry.name,
            input: asJson(entry.input),
            expectedOutput: entry.expectedOutput === null ? undefined : asJson(entry.expectedOutput),
            metadata: entry.metadata === null ? undefined : asJson(entry.metadata),
            tags: entry.tags,
          })),
        },
      },
    });
    return toDataset(row);
  },

  async update(
    datasetId: string,
    input: { name?: string; description?: string | null },
  ): Promise<Dataset> {
    const row = await getPrisma().dataset.update({
      where: { id: datasetId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
    });
    return toDataset(row);
  },

  /** Deletes the dataset (cases and versions cascade). Callers check for batches. */
  async delete(datasetId: string): Promise<void> {
    await getPrisma().dataset.delete({ where: { id: datasetId } });
  },

  async countBatches(datasetId: string): Promise<number> {
    return getPrisma().evaluationBatch.count({ where: { datasetId } });
  },

  /**
   * Experiments pin a dataset *version*, and one dataset version can be pinned
   * by several experiments — counting experiments (not versions) is what the
   * delete guard needs.
   */
  async countExperiments(datasetId: string): Promise<number> {
    return getPrisma().experiment.count({ where: { datasetId } });
  },

  // --- cases ----------------------------------------------------------------

  async listCases(datasetId: string): Promise<DatasetCase[]> {
    const rows = await getPrisma().datasetCase.findMany({
      where: { datasetId },
      orderBy: { caseKey: "asc" },
    });
    return rows.map(toCase);
  },

  async findCase(datasetId: string, caseKey: string): Promise<DatasetCase | null> {
    const row = await getPrisma().datasetCase.findUnique({
      where: { datasetId_caseKey: { datasetId, caseKey } },
    });
    return row ? toCase(row) : null;
  },

  /** Adds a case and keeps `caseCount` in step, atomically. */
  async addCase(datasetId: string, entry: DatasetCaseSnapshot): Promise<DatasetCase> {
    const prisma = getPrisma();
    const [row] = await prisma.$transaction([
      prisma.datasetCase.create({
        data: {
          datasetId,
          caseKey: entry.caseKey,
          name: entry.name,
          input: asJson(entry.input),
          expectedOutput: entry.expectedOutput === null ? undefined : asJson(entry.expectedOutput),
          metadata: entry.metadata === null ? undefined : asJson(entry.metadata),
          tags: entry.tags,
        },
      }),
      prisma.dataset.update({
        where: { id: datasetId },
        data: { caseCount: { increment: 1 } },
      }),
    ]);
    return toCase(row);
  },

  async updateCase(
    datasetId: string,
    caseKey: string,
    entry: Partial<Omit<DatasetCaseSnapshot, "caseKey">>,
  ): Promise<DatasetCase> {
    const row = await getPrisma().datasetCase.update({
      where: { datasetId_caseKey: { datasetId, caseKey } },
      data: {
        ...(entry.name !== undefined ? { name: entry.name } : {}),
        ...(entry.input !== undefined ? { input: asJson(entry.input) } : {}),
        // Prisma distinguishes SQL NULL from JSON null on a nullable Json
        // column; "no expected output" is SQL NULL.
        ...(entry.expectedOutput !== undefined
          ? {
              expectedOutput:
                entry.expectedOutput === null ? Prisma.DbNull : asJson(entry.expectedOutput),
            }
          : {}),
        ...(entry.metadata !== undefined
          ? { metadata: entry.metadata === null ? Prisma.DbNull : asJson(entry.metadata) }
          : {}),
        ...(entry.tags !== undefined ? { tags: entry.tags } : {}),
      },
    });
    return toCase(row);
  },

  /** Removes a case and keeps `caseCount` in step, atomically. */
  async removeCase(datasetId: string, caseKey: string): Promise<void> {
    const prisma = getPrisma();
    await prisma.$transaction([
      prisma.datasetCase.delete({ where: { datasetId_caseKey: { datasetId, caseKey } } }),
      prisma.dataset.update({
        where: { id: datasetId },
        data: { caseCount: { decrement: 1 } },
      }),
    ]);
  },

  // --- versions -------------------------------------------------------------

  async listVersions(datasetId: string): Promise<DatasetVersion[]> {
    const rows = await getPrisma().datasetVersion.findMany({
      where: { datasetId },
      orderBy: { version: "desc" },
    });
    return rows.map(toVersion);
  },

  async findVersionById(versionId: string): Promise<
    (DatasetVersion & { cases: DatasetCaseSnapshot[] }) | null
  > {
    const row = await getPrisma().datasetVersion.findUnique({ where: { id: versionId } });
    if (row === null) {
      return null;
    }
    return { ...toVersion(row), cases: parseCaseSnapshot(row.cases) };
  },

  async findVersionByNumber(
    datasetId: string,
    version: number,
  ): Promise<(DatasetVersion & { cases: DatasetCaseSnapshot[] }) | null> {
    const row = await getPrisma().datasetVersion.findUnique({
      where: { datasetId_version: { datasetId, version } },
    });
    if (row === null) {
      return null;
    }
    return { ...toVersion(row), cases: parseCaseSnapshot(row.cases) };
  },

  async findLatestVersion(
    datasetId: string,
  ): Promise<(DatasetVersion & { cases: DatasetCaseSnapshot[] }) | null> {
    const row = await getPrisma().datasetVersion.findFirst({
      where: { datasetId },
      orderBy: { version: "desc" },
    });
    if (row === null) {
      return null;
    }
    return { ...toVersion(row), cases: parseCaseSnapshot(row.cases) };
  },

  /**
   * Writes an immutable version snapshot and advances the dataset pointer in one
   * transaction. Publishing an identical snapshot at the same version number is
   * impossible (unique constraint), so a version number is never reused.
   */
  async publishVersion(input: {
    datasetId: string;
    version: number;
    name: string;
    cases: DatasetCaseSnapshot[];
    contentHash: string;
    createdBy?: string;
  }): Promise<DatasetVersion> {
    const prisma = getPrisma();
    const [row] = await prisma.$transaction([
      prisma.datasetVersion.create({
        data: {
          datasetId: input.datasetId,
          version: input.version,
          name: input.name,
          cases: input.cases as unknown as Prisma.InputJsonValue,
          caseCount: input.cases.length,
          contentHash: input.contentHash,
          createdBy: input.createdBy,
        },
      }),
      prisma.dataset.update({
        where: { id: input.datasetId },
        data: { currentVersion: input.version },
      }),
    ]);
    return toVersion(row);
  },
};
