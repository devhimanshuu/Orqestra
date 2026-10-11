import type { Prisma } from "@/generated/prisma/client";
import { getPrisma } from "@/lib/db/prisma";
import type { EvaluatorKind } from "./evaluation.types";
import type {
  EvaluatorConfigRecord,
  EvaluatorVersionRecord,
  EvaluatorWithVersion,
} from "./evaluator.types";

/**
 * Evaluator configuration persistence.
 *
 * Revisions are write-once (same rule as harness versions): `addVersion` inserts
 * a new revision and advances `currentVersion` in one transaction. A revision is
 * never updated, so a batch that pinned v3 keeps meaning exactly what it meant.
 */

function asJson(value: unknown): Prisma.InputJsonValue {
  return (value === undefined ? null : value) as Prisma.InputJsonValue;
}

function toConfig(row: {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  description: string | null;
  kind: string;
  enabled: boolean;
  currentVersion: number;
  createdAt: Date;
  updatedAt: Date;
}): EvaluatorConfigRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    slug: row.slug,
    description: row.description,
    kind: row.kind as EvaluatorKind,
    enabled: row.enabled,
    currentVersion: row.currentVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toVersion(row: {
  id: string;
  evaluatorId: string;
  version: number;
  name: string;
  kind: string;
  description: string | null;
  config: Prisma.JsonValue;
  weight: number;
  contentHash: string;
  createdBy: string | null;
  createdAt: Date;
}): EvaluatorVersionRecord {
  return {
    id: row.id,
    evaluatorId: row.evaluatorId,
    version: row.version,
    name: row.name,
    kind: row.kind as EvaluatorKind,
    description: row.description,
    config:
      row.config !== null && typeof row.config === "object" && !Array.isArray(row.config)
        ? (row.config as Record<string, unknown>)
        : {},
    weight: row.weight,
    contentHash: row.contentHash,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

export const evaluatorRepository = {
  async findById(evaluatorId: string): Promise<EvaluatorConfigRecord | null> {
    const row = await getPrisma().evaluator.findUnique({ where: { id: evaluatorId } });
    return row ? toConfig(row) : null;
  },

  async findBySlug(projectId: string, slug: string): Promise<EvaluatorConfigRecord | null> {
    const row = await getPrisma().evaluator.findUnique({
      where: { projectId_slug: { projectId, slug } },
    });
    return row ? toConfig(row) : null;
  },

  async findVersionById(versionId: string): Promise<EvaluatorVersionRecord | null> {
    const row = await getPrisma().evaluatorVersion.findUnique({ where: { id: versionId } });
    return row ? toVersion(row) : null;
  },

  async findVersion(
    evaluatorId: string,
    version: number,
  ): Promise<EvaluatorVersionRecord | null> {
    const row = await getPrisma().evaluatorVersion.findUnique({
      where: { evaluatorId_version: { evaluatorId, version } },
    });
    return row ? toVersion(row) : null;
  },

  async findCurrentVersion(evaluatorId: string): Promise<EvaluatorVersionRecord | null> {
    const row = await getPrisma().evaluatorVersion.findFirst({
      where: { evaluatorId },
      orderBy: { version: "desc" },
    });
    return row ? toVersion(row) : null;
  },

  async listVersions(evaluatorId: string): Promise<EvaluatorVersionRecord[]> {
    const rows = await getPrisma().evaluatorVersion.findMany({
      where: { evaluatorId },
      orderBy: { version: "desc" },
    });
    return rows.map(toVersion);
  },

  /** Evaluators of a project with their current revision. */
  async listByProject(projectId: string): Promise<EvaluatorWithVersion[]> {
    const rows = await getPrisma().evaluator.findMany({
      where: { projectId },
      orderBy: { updatedAt: "desc" },
      include: {
        versions: { orderBy: { version: "desc" }, take: 1 },
        _count: { select: { versions: true } },
      },
    });
    return rows
      .filter((row) => row.versions[0] !== undefined)
      .map((row) => ({
        ...toConfig(row),
        current: toVersion(row.versions[0] as NonNullable<(typeof row.versions)[0]>),
        versionCount: row._count.versions,
      }));
  },

  async listByProjects(projectIds: string[]): Promise<EvaluatorWithVersion[]> {
    const rows = await getPrisma().evaluator.findMany({
      where: { projectId: { in: projectIds } },
      orderBy: { updatedAt: "desc" },
      include: {
        versions: { orderBy: { version: "desc" }, take: 1 },
        _count: { select: { versions: true } },
      },
    });
    return rows
      .filter((row) => row.versions[0] !== undefined)
      .map((row) => ({
        ...toConfig(row),
        current: toVersion(row.versions[0] as NonNullable<(typeof row.versions)[0]>),
        versionCount: row._count.versions,
      }));
  },

  /** Creates the configuration and revision 1 atomically. */
  async createWithVersion(input: {
    projectId: string;
    name: string;
    slug: string;
    description?: string | null;
    kind: string;
    config: Record<string, unknown>;
    weight: number;
    contentHash: string;
    createdBy?: string;
  }): Promise<{ evaluator: EvaluatorConfigRecord; version: EvaluatorVersionRecord }> {
    const row = await getPrisma().evaluator.create({
      data: {
        projectId: input.projectId,
        name: input.name,
        slug: input.slug,
        description: input.description,
        kind: input.kind,
        currentVersion: 1,
        versions: {
          create: {
            version: 1,
            name: input.name,
            kind: input.kind,
            description: input.description,
            config: asJson(input.config),
            weight: input.weight,
            contentHash: input.contentHash,
            createdBy: input.createdBy,
          },
        },
      },
      include: { versions: true },
    });
    const versionRow = row.versions[0];
    if (versionRow === undefined) {
      throw new Error("Evaluator created without an initial revision");
    }
    return { evaluator: toConfig(row), version: toVersion(versionRow) };
  },

  async updateMetadata(
    evaluatorId: string,
    input: { name?: string; description?: string | null; enabled?: boolean },
  ): Promise<EvaluatorConfigRecord> {
    const row = await getPrisma().evaluator.update({
      where: { id: evaluatorId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      },
    });
    return toConfig(row);
  },

  /** Publishes revision N and advances the pointer atomically. */
  async addVersion(input: {
    evaluatorId: string;
    version: number;
    name: string;
    kind: string;
    description?: string | null;
    config: Record<string, unknown>;
    weight: number;
    contentHash: string;
    createdBy?: string;
  }): Promise<EvaluatorVersionRecord> {
    const prisma = getPrisma();
    const [versionRow] = await prisma.$transaction([
      prisma.evaluatorVersion.create({
        data: {
          evaluatorId: input.evaluatorId,
          version: input.version,
          name: input.name,
          kind: input.kind,
          description: input.description,
          config: asJson(input.config),
          weight: input.weight,
          contentHash: input.contentHash,
          createdBy: input.createdBy,
        },
      }),
      prisma.evaluator.update({
        where: { id: input.evaluatorId },
        data: { currentVersion: input.version },
      }),
    ]);
    return toVersion(versionRow);
  },

  /** Deletes the configuration and its revisions. Batch results keep snapshots. */
  async delete(evaluatorId: string): Promise<void> {
    await getPrisma().evaluator.delete({ where: { id: evaluatorId } });
  },

  async countByProject(projectId: string): Promise<number> {
    return getPrisma().evaluator.count({ where: { projectId } });
  },

  async countVersions(evaluatorId: string): Promise<number> {
    return getPrisma().evaluatorVersion.count({ where: { evaluatorId } });
  },
};
