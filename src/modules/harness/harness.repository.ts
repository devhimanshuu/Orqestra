import type { Prisma } from "@/generated/prisma/client";
import { getPrisma } from "@/lib/db/prisma";
import { assertHarnessDefinition } from "./harness.serialize";
import type {
  Harness,
  HarnessDraft,
  HarnessStatus,
  HarnessSummary,
  HarnessVersion,
} from "./harness.types";

/**
 * Harness persistence. All Prisma access for harnesses lives here — services
 * compose business rules on top; UI code never touches this module.
 */

export function toHarness(row: {
  id: string;
  projectId: string;
  agentId: string | null;
  name: string;
  slug: string;
  description: string | null;
  currentVersion: number;
  status: string;
  nodeCount: number;
  edgeCount: number;
  createdAt: Date;
  updatedAt: Date;
}): Harness {
  return {
    id: row.id,
    projectId: row.projectId,
    agentId: row.agentId,
    name: row.name,
    slug: row.slug,
    description: row.description,
    currentVersion: row.currentVersion,
    status: row.status as HarnessStatus,
    nodeCount: row.nodeCount,
    edgeCount: row.edgeCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toHarnessSummary(row: Parameters<typeof toHarness>[0]): HarnessSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    agentId: row.agentId,
    name: row.name,
    slug: row.slug,
    description: row.description,
    status: row.status as HarnessStatus,
    currentVersion: row.currentVersion,
    nodeCount: row.nodeCount,
    edgeCount: row.edgeCount,
    updatedAt: row.updatedAt,
  };
}

export function toHarnessVersion(row: {
  id: string;
  harnessId: string;
  version: number;
  name: string;
  definition: Prisma.JsonValue;
  contentHash: string;
  entryNode: string;
  status: string;
  releaseNotes: string | null;
  createdBy: string | null;
  createdAt: Date;
}): HarnessVersion {
  return {
    id: row.id,
    harnessId: row.harnessId,
    version: row.version,
    name: row.name,
    // Throws if a stored row is corrupt — that is a data-integrity bug, not a
    // recoverable condition. Old dialects are upgraded in memory first.
    definition: assertHarnessDefinition(row.definition),
    contentHash: row.contentHash,
    entryNode: row.entryNode,
    status: row.status,
    releaseNotes: row.releaseNotes,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

export function toDraft(row: {
  harnessId: string;
  definition: Prisma.JsonValue;
  updatedBy: string | null;
  updatedAt: Date;
}): HarnessDraft {
  return {
    harnessId: row.harnessId,
    // Drafts may be invalid while being edited, so they are stored as-is and
    // validated by the caller (the builder always shows validation state).
    definition: row.definition as unknown,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}

export interface CreateHarnessRowsInput {
  projectId: string;
  agentId?: string;
  name: string;
  slug: string;
  description?: string;
  definition: unknown;
  contentHash: string;
  entryNode: string;
  nodeCount: number;
  edgeCount: number;
  status: HarnessStatus;
  createdBy?: string;
}

export interface CreateVersionInput {
  harnessId: string;
  version: number;
  name: string;
  definition: unknown;
  contentHash: string;
  entryNode: string;
  nodeCount: number;
  edgeCount: number;
  releaseNotes?: string | null;
  createdBy?: string;
}

export const harnessRepository = {
  async findById(id: string): Promise<Harness | null> {
    const row = await getPrisma().harness.findUnique({ where: { id } });
    return row ? toHarness(row) : null;
  },

  async findBySlug(projectId: string, slug: string): Promise<Harness | null> {
    const row = await getPrisma().harness.findUnique({
      where: { projectId_slug: { projectId, slug } },
    });
    return row ? toHarness(row) : null;
  },

  async listByProject(projectId: string): Promise<HarnessSummary[]> {
    const rows = await getPrisma().harness.findMany({
      where: { projectId },
      orderBy: { updatedAt: "desc" },
    });
    return rows.map(toHarnessSummary);
  },

  async listByAgent(agentId: string): Promise<HarnessSummary[]> {
    const rows = await getPrisma().harness.findMany({
      where: { agentId },
      orderBy: { updatedAt: "desc" },
    });
    return rows.map(toHarnessSummary);
  },

  async listVersions(harnessId: string): Promise<HarnessVersion[]> {
    const rows = await getPrisma().harnessVersion.findMany({
      where: { harnessId },
      orderBy: { version: "desc" },
    });
    return rows.map(toHarnessVersion);
  },

  async findLatestVersion(harnessId: string): Promise<HarnessVersion | null> {
    const row = await getPrisma().harnessVersion.findFirst({
      where: { harnessId },
      orderBy: { version: "desc" },
    });
    return row ? toHarnessVersion(row) : null;
  },

  async findVersionById(id: string): Promise<HarnessVersion | null> {
    const row = await getPrisma().harnessVersion.findUnique({ where: { id } });
    return row ? toHarnessVersion(row) : null;
  },

  async findVersionByNumber(harnessId: string, version: number): Promise<HarnessVersion | null> {
    const row = await getPrisma().harnessVersion.findUnique({
      where: { harnessId_version: { harnessId, version } },
    });
    return row ? toHarnessVersion(row) : null;
  },

  async findDraft(harnessId: string): Promise<HarnessDraft | null> {
    const row = await getPrisma().harnessDraft.findUnique({ where: { harnessId } });
    return row ? toDraft(row) : null;
  },

  async upsertDraft(input: {
    harnessId: string;
    definition: unknown;
    status: HarnessStatus;
    nodeCount: number;
    edgeCount: number;
    updatedBy?: string;
  }): Promise<HarnessDraft> {
    const prisma = getPrisma();
    const [draftRow] = await prisma.$transaction([
      prisma.harnessDraft.upsert({
        where: { harnessId: input.harnessId },
        create: {
          harnessId: input.harnessId,
          definition: input.definition as Prisma.InputJsonValue,
          updatedBy: input.updatedBy,
        },
        update: {
          definition: input.definition as Prisma.InputJsonValue,
          updatedBy: input.updatedBy,
        },
      }),
      prisma.harness.update({
        where: { id: input.harnessId },
        data: {
          status: input.status,
          nodeCount: input.nodeCount,
          edgeCount: input.edgeCount,
        },
      }),
    ]);
    return toDraft(draftRow);
  },

  async updateHarness(
    harnessId: string,
    input: {
      name?: string;
      description?: string | null;
      status?: HarnessStatus;
      nodeCount?: number;
      edgeCount?: number;
    },
  ): Promise<Harness> {
    const row = await getPrisma().harness.update({
      where: { id: harnessId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.nodeCount !== undefined ? { nodeCount: input.nodeCount } : {}),
        ...(input.edgeCount !== undefined ? { edgeCount: input.edgeCount } : {}),
      },
    });
    return toHarness(row);
  },

  /** Creates Harness + version 1 atomically (nested write = one transaction). */
  async createWithVersion(
    input: CreateHarnessRowsInput,
  ): Promise<{ harness: Harness; harnessVersion: HarnessVersion }> {
    const row = await getPrisma().harness.create({
      data: {
        projectId: input.projectId,
        agentId: input.agentId,
        name: input.name,
        slug: input.slug,
        description: input.description,
        currentVersion: 1,
        status: input.status,
        nodeCount: input.nodeCount,
        edgeCount: input.edgeCount,
        versions: {
          create: {
            version: 1,
            name: input.name,
            definition: input.definition as Prisma.InputJsonValue,
            contentHash: input.contentHash,
            entryNode: input.entryNode,
            status: "VALID",
            releaseNotes: "Initial version",
            createdBy: input.createdBy,
          },
        },
      },
      include: { versions: true },
    });
    const versionRow = row.versions[0];
    if (versionRow === undefined) {
      throw new Error("Harness created without an initial version");
    }
    return { harness: toHarness(row), harnessVersion: toHarnessVersion(versionRow) };
  },

  /** Publishes version N and advances the harness pointer + counts atomically. */
  async createNextVersion(input: CreateVersionInput): Promise<HarnessVersion> {
    const prisma = getPrisma();
    const [versionRow] = await prisma.$transaction([
      prisma.harnessVersion.create({
        data: {
          harnessId: input.harnessId,
          version: input.version,
          name: input.name,
          definition: input.definition as Prisma.InputJsonValue,
          contentHash: input.contentHash,
          entryNode: input.entryNode,
          status: "VALID",
          releaseNotes: input.releaseNotes,
          createdBy: input.createdBy,
        },
      }),
      prisma.harness.update({
        where: { id: input.harnessId },
        data: {
          currentVersion: input.version,
          status: "VALID",
          nodeCount: input.nodeCount,
          edgeCount: input.edgeCount,
        },
      }),
    ]);
    return toHarnessVersion(versionRow);
  },

  async countRuns(harnessId: string): Promise<number> {
    return getPrisma().run.count({ where: { harnessId } });
  },

  async countVersions(harnessId: string): Promise<number> {
    return getPrisma().harnessVersion.count({ where: { harnessId } });
  },

  /** Raw harness row lookup by slug within a project, used to derive unique slugs. */
  async slugExists(projectId: string, slug: string): Promise<boolean> {
    const row = await getPrisma().harness.findUnique({
      where: { projectId_slug: { projectId, slug } },
      select: { id: true },
    });
    return row !== null;
  },

  async findAgentSummary(agentId: string): Promise<{ id: string; name: string } | null> {
    const row = await getPrisma().agent.findUnique({
      where: { id: agentId },
      select: { id: true, name: true },
    });
    return row;
  },
};
