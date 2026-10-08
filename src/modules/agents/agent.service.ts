import { z } from "zod";
import type { AuthUser } from "@/lib/auth/provider";
import { logger } from "@/lib/logging/logger";
import { slugifyOrDefault } from "@/lib/slugify";
import { assertAgentAccess, assertProjectAccess } from "@/modules/access/access.service";
import { harnessRepository } from "@/modules/harness/harness.repository";
import { agentRepository } from "./agent.repository";
import type {
  Agent,
  AgentModelConfig,
  AgentOverview,
  AgentSummary,
  AgentVersion,
  CreateAgentInput,
  UpdateAgentInput,
} from "./agent.types";
import { AgentInputError, AgentNotFoundError } from "./agent.types";

/**
 * Agent service — identity and version management only.
 *
 * Behaviour (how the agent reasons, uses tools, loops, terminates) belongs to
 * the Harness module; the agent never encodes a flow.
 *
 * Every edit produces a new immutable `AgentVersion`, mirroring harness
 * versioning, so runs can always be attributed to an exact configuration.
 */

export const agentModelConfigSchema = z.object({
  model: z.string().min(1, "Pick a model"),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().max(200_000).optional(),
});

const createAgentSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  description: z.string().trim().max(500).optional(),
  purpose: z.string().trim().max(500).optional(),
  instructions: z.string().trim().min(1, "System instructions are required").max(20_000),
  slug: z.string().trim().max(60).optional(),
  modelConfig: agentModelConfigSchema,
  capabilities: z.array(z.string().min(1)).max(50).optional(),
});

const updateAgentSchema = createAgentSchema.partial().extend({
  instructions: z.string().trim().min(1, "System instructions are required").max(20_000),
  modelConfig: agentModelConfigSchema,
});

function parseModelConfig(input: unknown): AgentModelConfig {
  const result = agentModelConfigSchema.safeParse(input);
  if (!result.success) {
    throw new AgentInputError(
      `Invalid model config: ${result.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  return result.data;
}

export async function createAgent(
  user: AuthUser,
  projectId: string,
  input: unknown,
): Promise<{ agent: Agent; agentVersion: AgentVersion }> {
  const parsed = createAgentSchema.parse(input);
  await assertProjectAccess(user.id, projectId);

  const slug = slugifyOrDefault(parsed.slug ?? parsed.name, "agent");
  const existing = await agentRepository.findBySlug(projectId, slug);
  if (existing !== null) {
    throw new AgentInputError(`An agent with slug "${slug}" already exists in this project`);
  }

  const created = await agentRepository.createWithVersion({
    projectId,
    name: parsed.name,
    slug,
    description: parsed.description,
    purpose: parsed.purpose,
    instructions: parsed.instructions,
    modelConfig: parseModelConfig(parsed.modelConfig),
    capabilities: parsed.capabilities ?? [],
    createdBy: user.id,
  });

  logger.info("agent created", { agentId: created.agent.id, projectId, userId: user.id });
  return created;
}

export async function listAgents(user: AuthUser, projectId: string): Promise<AgentSummary[]> {
  await assertProjectAccess(user.id, projectId);
  return agentRepository.listByProject(projectId);
}

export async function getAgentOverview(user: AuthUser, agentId: string): Promise<AgentOverview> {
  const agent = await assertAgentAccess(user.id, agentId);
  const latestVersion = await agentRepository.findLatestVersion(agent.id);
  if (latestVersion === null) {
    throw new AgentNotFoundError(agent.id);
  }

  const [harnessRows, runCount, versionCount] = await Promise.all([
    harnessRepository.listByAgent(agent.id),
    agentRepository.countRuns(agent.id),
    agentRepository.countVersions(agent.id),
  ]);

  const harnesses = harnessRows.map((harness) => ({
    id: harness.id,
    name: harness.name,
    slug: harness.slug,
    status: harness.status,
    currentVersion: harness.currentVersion,
    updatedAt: harness.updatedAt,
    nodeCount: harness.nodeCount,
  }));

  return { ...agent, latestVersion, harnesses, runCount, versionCount };
}

export async function updateAgent(
  user: AuthUser,
  agentId: string,
  input: unknown,
): Promise<{ agent: Agent; agentVersion: AgentVersion }> {
  const parsed = updateAgentSchema.parse(input);
  const agent = await assertAgentAccess(user.id, agentId);

  const latest = await agentRepository.findLatestVersion(agent.id);
  const agentVersion = await agentRepository.createNextVersion({
    agentId: agent.id,
    version: (latest?.version ?? 0) + 1,
    purpose: parsed.purpose ?? latest?.purpose ?? undefined,
    instructions: parsed.instructions,
    modelConfig: parseModelConfig(parsed.modelConfig),
    capabilities: parsed.capabilities ?? latest?.capabilities ?? [],
    createdBy: user.id,
  });

  const updated =
    parsed.name !== undefined || parsed.description !== undefined
      ? await agentRepository.updateMetadata(agent.id, {
          ...(parsed.name !== undefined ? { name: parsed.name } : {}),
          ...(parsed.description !== undefined ? { description: parsed.description } : {}),
        })
      : agent;

  logger.info("agent version created", {
    agentId: agent.id,
    version: agentVersion.version,
    userId: user.id,
  });
  return { agent: updated, agentVersion };
}

export async function listAgentVersions(user: AuthUser, agentId: string): Promise<AgentVersion[]> {
  const agent = await assertAgentAccess(user.id, agentId);
  return agentRepository.listVersions(agent.id);
}

export type { CreateAgentInput, UpdateAgentInput };
