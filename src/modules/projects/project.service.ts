import type { AuthUser } from "@/lib/auth/provider";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logging/logger";
import { slugifyOrDefault } from "@/lib/slugify";
import { assertProjectAccess, ensureDefaultWorkspace } from "@/modules/access/access.service";
import { agentRepository } from "@/modules/agents/agent.repository";
import type { AgentSummary } from "@/modules/agents/agent.types";
import { harnessRepository } from "@/modules/harness/harness.repository";
import type { HarnessSummary } from "@/modules/harness/harness.types";
import { projectRepository } from "./project.repository";
import type {
  CreateProjectInput,
  Project,
  ProjectWithCounts,
  UpdateProjectInput,
} from "./project.types";

/**
 * Project service — the entry point of the product flow:
 * dashboard → projects → agents → harnesses.
 */

export interface ProjectDetail {
  project: Project;
  agents: AgentSummary[];
  harnesses: HarnessSummary[];
}

export async function createProject(
  user: AuthUser,
  input: CreateProjectInput,
): Promise<Project> {
  const workspace = await ensureDefaultWorkspace(user);
  const slug = slugifyOrDefault(input.slug ?? input.name, "project");

  const existing = await projectRepository.findBySlug(workspace.id, slug);
  if (existing !== null) {
    throw new ConflictError(`A project named "${input.name}" already exists`);
  }

  const project = await projectRepository.create({
    workspaceId: workspace.id,
    name: input.name.trim(),
    slug,
    ...(input.description !== undefined ? { description: input.description } : {}),
  });
  logger.info("project created", { projectId: project.id, userId: user.id });
  return project;
}

export async function listProjects(user: AuthUser): Promise<ProjectWithCounts[]> {
  const workspace = await ensureDefaultWorkspace(user);
  return projectRepository.listByWorkspace(workspace.id);
}

export async function getProjectDetail(user: AuthUser, projectId: string): Promise<ProjectDetail> {
  const project = await assertProjectAccess(user.id, projectId);
  const [agents, harnesses] = await Promise.all([
    agentRepository.listByProject(project.id),
    harnessRepository.listByProject(project.id),
  ]);
  return { project, agents, harnesses };
}

export async function updateProject(
  user: AuthUser,
  projectId: string,
  input: UpdateProjectInput,
): Promise<Project> {
  await assertProjectAccess(user.id, projectId);

  const project = await projectRepository.update(projectId, {
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
  });
  logger.info("project updated", { projectId: project.id, userId: user.id });
  return project;
}

export async function requireProject(projectId: string): Promise<Project> {
  const project = await projectRepository.findById(projectId);
  if (project === null) {
    throw new NotFoundError("Project not found");
  }
  return project;
}
