import type { Metadata } from "next";
import { Suspense } from "react";
import { ProjectsView, type ProjectDto } from "@/components/projects-view";
import { SignOutButton } from "@/components/sign-out-button";
import { getCurrentUser } from "@/lib/auth/session";
import { listProjects } from "@/modules/projects/project.service";

export const metadata: Metadata = {
  title: "Dashboard",
};

/**
 * Dashboard = projects. The product flow continues from a project card:
 * project → agents → harnesses → builder.
 */
async function DashboardData() {
  const user = await getCurrentUser();
  const projects = await listProjects(user);

  const projectDtos: ProjectDto[] = projects.map((project) => ({
    id: project.id,
    name: project.name,
    slug: project.slug,
    description: project.description,
    createdAt: project.createdAt.toISOString(),
    counts: project.counts,
  }));

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-10">
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Orqestra</h1>
          <p className="text-sm text-muted-foreground">
            The model provides intelligence; the harness controls behavior.
          </p>
          <p className="text-xs text-muted-foreground">
            {user.name} · {user.email}
          </p>
        </div>
        <SignOutButton />
      </header>

      <ProjectsView projects={projectDtos} />
    </main>
  );
}

export default function DashboardPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto w-full max-w-4xl px-6 py-10 text-sm text-muted-foreground">
          Loading dashboard…
        </main>
      }
    >
      <DashboardData />
    </Suspense>
  );
}
