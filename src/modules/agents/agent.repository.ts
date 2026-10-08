import type { Prisma } from "@/generated/prisma/client";
import { getPrisma } from "@/lib/db/prisma";
import type { Agent, AgentModelConfig, AgentSummary, AgentVersion } from "./agent.types";

/**
 * Agent persistence. Row ↔ domain mapping keeps Prisma types out of
 * services and UI.
 */

export function toAgent(row: {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  description: string | null;
  currentVersion: number;
  createdAt: Date;
  updatedAt: Date;
}): Agent {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    slug: row.slug,
    description: row.description,
    currentVersion: row.currentVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toModelConfig(value: Prisma.JsonValue): AgentModelConfig {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record["model"] === "string") {
      return value as unknown as AgentModelConfig;
    }
  }
  // Rows are written from validated input — a malformed value is a data bug.
  throw new Error("AgentVersion.modelConfig is corrupt");
}

export function toAgentVersion(row: {
  id: string;
  agentId: string;
  version: number;
  purpose: string | null;
  instructions: Prisma.JsonValue;
  modelConfig: Prisma.JsonValue;
  capabilities: Prisma.JsonValue;
  createdBy: string | null;
  createdAt: Date;
}): AgentVersion {
  const modelConfig = toModelConfig(row.modelConfig);
  const capabilities = Array.isArray(row.capabilities)
    ? row.capabilities.filter((item): item is string => typeof item === "string")
    : [];
  return {
    id: row.id,
    agentId: row.agentId,
    version: row.version,
    purpose: row.purpose,
    instructions: typeof row.instructions === "string" ? row.instructions : "",
    modelConfig,
    capabilities,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

export interface CreateAgentRowsInput {
  projectId: string;
  name: string;
  slug: string;
  description?: string;
  purpose?: string;
  instructions: string;
  modelConfig: AgentModelConfig;
  capabilities: string[];
  createdBy?: string;
}

export interface CreateAgentVersionRowsInput {
  agentId: string;
  version: number;
  purpose?: string;
  instructions: string;
  modelConfig: AgentModelConfig;
  capabilities: string[];
  createdBy?: string;
}

export const agentRepository = {
  async findById(id: string): Promise<Agent | null> {
    const row = await getPrisma().agent.findUnique({ where: { id } });
    return row ? toAgent(row) : null;
  },

  async findBySlug(projectId: string, slug: string): Promise<Agent | null> {
    const row = await getPrisma().agent.findUnique({
      where: { projectId_slug: { projectId, slug } },
    });
    return row ? toAgent(row) : null;
  },

  async findLatestVersion(agentId: string): Promise<AgentVersion | null> {
    const row = await getPrisma().agentVersion.findFirst({
      where: { agentId },
      orderBy: { version: "desc" },
    });
    return row ? toAgentVersion(row) : null;
  },

  /** Project list projection: agent + latest version + harness count. */
  async listByProject(projectId: string): Promise<AgentSummary[]> {
    const rows = await getPrisma().agent.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
      include: {
        versions: { orderBy: { version: "desc" }, take: 1 },
        _count: { select: { harnesses: true } },
      },
    });
    return rows.map((row) => {
      const latest = row.versions[0];
      return {
        ...toAgent(row),
        purpose: latest?.purpose ?? null,
        modelConfig: latest ? toModelConfig(latest.modelConfig) : { model: "" },
        harnessCount: row._count.harnesses,
      };
    });
  },

  async updateMetadata(
    agentId: string,
    input: { name?: string; description?: string | null },
  ): Promise<Agent> {
    const row = await getPrisma().agent.update({
      where: { id: agentId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
    });
    return toAgent(row);
  },

  async countVersions(agentId: string): Promise<number> {
    return getPrisma().agentVersion.count({ where: { agentId } });
  },

  /** Runs attributed to this agent (agentId is denormalised on Run). */
  async countRuns(agentId: string): Promise<number> {
    return getPrisma().run.count({ where: { agentId } });
  },

  async listVersions(agentId: string): Promise<AgentVersion[]> {
    const rows = await getPrisma().agentVersion.findMany({
      where: { agentId },
      orderBy: { version: "desc" },
    });
    return rows.map(toAgentVersion);
  },

  /** Creates Agent + version 1 atomically (nested write = one transaction). */
  async createWithVersion(
    input: CreateAgentRowsInput,
  ): Promise<{ agent: Agent; agentVersion: AgentVersion }> {
    const row = await getPrisma().agent.create({
      data: {
        projectId: input.projectId,
        name: input.name,
        slug: input.slug,
        description: input.description,
        currentVersion: 1,
        versions: {
          create: {
            version: 1,
            purpose: input.purpose,
            instructions: input.instructions,
            modelConfig: input.modelConfig as unknown as Prisma.InputJsonValue,
            capabilities: input.capabilities as unknown as Prisma.InputJsonValue,
            createdBy: input.createdBy,
          },
        },
      },
      include: { versions: true },
    });
    const versionRow = row.versions[0];
    if (versionRow === undefined) {
      throw new Error("Agent created without an initial version");
    }
    return { agent: toAgent(row), agentVersion: toAgentVersion(versionRow) };
  },

  /** Creates version N+1 and advances the agent pointer atomically. */
  async createNextVersion(input: CreateAgentVersionRowsInput): Promise<AgentVersion> {
    const prisma = getPrisma();
    const [versionRow] = await prisma.$transaction([
      prisma.agentVersion.create({
        data: {
          agentId: input.agentId,
          version: input.version,
          purpose: input.purpose,
          instructions: input.instructions,
          modelConfig: input.modelConfig as unknown as Prisma.InputJsonValue,
          capabilities: input.capabilities as unknown as Prisma.InputJsonValue,
          createdBy: input.createdBy,
        },
      }),
      prisma.agent.update({
        where: { id: input.agentId },
        data: { currentVersion: input.version },
      }),
    ]);
    return toAgentVersion(versionRow);
  },
};
