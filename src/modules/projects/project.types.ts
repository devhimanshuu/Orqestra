/**
 * Tenancy domain types: Workspace → Project.
 *
 * Phase 1 keeps tenancy deliberately shallow: every user gets a default
 * workspace, projects live inside it, and all access checks are membership
 * checks. Roles and invitations are a later phase.
 */

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectCounts {
  agents: number;
  harnesses: number;
}

export interface ProjectWithCounts extends Project {
  counts: ProjectCounts;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  slug?: string;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
}
