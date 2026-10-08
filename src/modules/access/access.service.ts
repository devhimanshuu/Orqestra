import { NotFoundError } from "@/lib/errors";
import { slugifyOrDefault } from "@/lib/slugify";
import type { AuthUser } from "@/lib/auth/provider";
import { agentRepository } from "@/modules/agents/agent.repository";
import type { Agent } from "@/modules/agents/agent.types";
import { harnessRepository } from "@/modules/harness/harness.repository";
import type { Harness } from "@/modules/harness/harness.types";
import { projectRepository } from "@/modules/projects/project.repository";
import type { Project, Workspace } from "@/modules/projects/project.types";
import { workspaceRepository } from "@/modules/projects/workspace.repository";

/**
 * Access control for tenancy-scoped resources.
 *
 * Every resource hangs off a workspace; a request is authorized iff the user
 * is a member of that workspace. Non-members get a 404 (not a 403) so resource
 * existence is never disclosed across tenants.
 *
 * Services call these guards; route handlers never perform checks themselves.
 */

export async function assertWorkspaceAccess(userId: string, workspaceId: string): Promise<void> {
  const membership = await workspaceRepository.findMembership(userId, workspaceId);
  if (membership === null) {
    throw new NotFoundError("Workspace not found");
  }
}

export async function assertProjectAccess(userId: string, projectId: string): Promise<Project> {
  const project = await projectRepository.findById(projectId);
  if (project === null) {
    throw new NotFoundError("Project not found");
  }
  await assertWorkspaceAccess(userId, project.workspaceId);
  return project;
}

export async function assertAgentAccess(userId: string, agentId: string): Promise<Agent> {
  const agent = await agentRepository.findById(agentId);
  if (agent === null) {
    throw new NotFoundError("Agent not found");
  }
  await assertProjectAccess(userId, agent.projectId);
  return agent;
}

export async function assertHarnessAccess(userId: string, harnessId: string): Promise<Harness> {
  const harness = await harnessRepository.findById(harnessId);
  if (harness === null) {
    throw new NotFoundError("Harness not found");
  }
  await assertProjectAccess(userId, harness.projectId);
  return harness;
}

/**
 * The workspace a user's work lives in. Phase 1 has no workspace switcher, so
 * the first membership (or a freshly created default workspace) is used.
 */
export async function ensureDefaultWorkspace(user: AuthUser): Promise<Workspace> {
  const existing = await workspaceRepository.findFirstForUser(user.id);
  if (existing !== null) {
    return existing;
  }
  const base = slugifyOrDefault(`${user.name}-workspace`, "workspace");
  return workspaceRepository.createWithOwner({
    name: `${user.name}'s Workspace`,
    slug: `${base}-${user.id.slice(-6)}`,
    ownerId: user.id,
  });
}
