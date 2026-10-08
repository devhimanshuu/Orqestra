import { getPrisma } from "@/lib/db/prisma";
import type { Workspace } from "./project.types";

export function toWorkspace(row: {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
}): Workspace {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const workspaceRepository = {
  async findById(id: string): Promise<Workspace | null> {
    const row = await getPrisma().workspace.findUnique({ where: { id } });
    return row ? toWorkspace(row) : null;
  },

  async findMembership(userId: string, workspaceId: string): Promise<{ role: string } | null> {
    const row = await getPrisma().workspaceMember.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
      select: { role: true },
    });
    return row;
  },

  /** First workspace the user belongs to (Phase 1 has no workspace switcher). */
  async findFirstForUser(userId: string): Promise<Workspace | null> {
    const row = await getPrisma().workspace.findFirst({
      where: { members: { some: { userId } } },
      orderBy: { createdAt: "asc" },
    });
    return row ? toWorkspace(row) : null;
  },

  async createWithOwner(input: {
    name: string;
    slug: string;
    ownerId: string;
  }): Promise<Workspace> {
    const row = await getPrisma().workspace.create({
      data: {
        name: input.name,
        slug: input.slug,
        members: { create: { userId: input.ownerId, role: "owner" } },
      },
    });
    return toWorkspace(row);
  },
};
