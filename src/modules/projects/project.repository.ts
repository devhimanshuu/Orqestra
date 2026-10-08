import { getPrisma } from "@/lib/db/prisma";
import type { Project, ProjectWithCounts } from "./project.types";

/**
 * Project persistence. Uniqueness is per workspace (`@@unique([workspaceId, slug])`).
 */

export function toProject(row: {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}): Project {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    slug: row.slug,
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const projectRepository = {
  async findById(id: string): Promise<Project | null> {
    const row = await getPrisma().project.findUnique({ where: { id } });
    return row ? toProject(row) : null;
  },

  async findBySlug(workspaceId: string, slug: string): Promise<Project | null> {
    const row = await getPrisma().project.findUnique({
      where: { workspaceId_slug: { workspaceId, slug } },
    });
    return row ? toProject(row) : null;
  },

  async listByWorkspace(workspaceId: string): Promise<ProjectWithCounts[]> {
    const rows = await getPrisma().project.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { agents: true, harnesses: true } } },
    });
    return rows.map((row) => ({
      ...toProject(row),
      counts: { agents: row._count.agents, harnesses: row._count.harnesses },
    }));
  },

  async create(input: {
    workspaceId: string;
    name: string;
    slug: string;
    description?: string;
  }): Promise<Project> {
    const row = await getPrisma().project.create({
      data: {
        workspaceId: input.workspaceId,
        name: input.name,
        slug: input.slug,
        description: input.description,
      },
    });
    return toProject(row);
  },

  async update(
    id: string,
    input: { name?: string; description?: string | null },
  ): Promise<Project> {
    const row = await getPrisma().project.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
    });
    return toProject(row);
  },
};
