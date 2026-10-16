import type { Metadata } from "next";
import { Suspense } from "react";
import { ProjectsView, type ProjectDto } from "@/components/projects-view";
import { SystemStatus } from "@/components/system-status";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { getCurrentUser } from "@/lib/auth/session";
import { listProjects } from "@/modules/projects/project.service";
import { listRuns } from "@/modules/runtime/run.service";
import { listRunsQuerySchema } from "@/modules/runtime/run.inputs";

export const metadata: Metadata = {
  title: "Dashboard · Orqestra",
};

/**
 * Workspace overview.
 *
 * Shows the user's projects (the primary navigation target) and system health.
 * Metrics are derived from real data only — no fabricated dashboard numbers.
 * The user's email is rendered for e2e assertions (auth.spec.ts).
 */
async function DashboardData() {
  const user = await getCurrentUser();
  const [projects, runsPage] = await Promise.all([
    listProjects(user),
    listRuns(user, listRunsQuerySchema.parse({})).catch(() => ({
      runs: [],
      total: 0,
      limit: 20,
      offset: 0,
    })),
  ]);

  const projectDtos: ProjectDto[] = projects.map((project) => ({
    id: project.id,
    name: project.name,
    slug: project.slug,
    description: project.description,
    createdAt: project.createdAt.toISOString(),
    counts: project.counts,
  }));

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Projects"
        description={
          <>
            Organize agents, harnesses, and evaluation suites.{" "}
            <span className="font-mono text-xs">{user.email}</span>
          </>
        }
      />

      {/* Projects */}
      <ProjectsView projects={projectDtos} />

      {/* System health */}
      <section className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SystemStatus />
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Engine</CardTitle>
            <CardDescription className="text-xs">
              Runtime infrastructure
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-xs">
            <div className="flex items-center justify-between border-b border-border/50 py-1.5">
              <span className="text-muted-foreground">Compiler</span>
              <span className="font-mono font-medium">v1.0</span>
            </div>
            <div className="flex items-center justify-between border-b border-border/50 py-1.5">
              <span className="text-muted-foreground">Queue</span>
              <span className="font-mono font-medium">BullMQ + Redis</span>
            </div>
            <div className="flex items-center justify-between border-b border-border/50 py-1.5">
              <span className="text-muted-foreground">Database</span>
              <span className="font-mono font-medium">PostgreSQL + Prisma</span>
            </div>
            <div className="flex items-center justify-between py-1.5">
              <span className="text-muted-foreground">Runs</span>
              <span className="font-mono font-medium">{runsPage.total}</span>
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[50vh] items-center justify-center">
          <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <p>Loading…</p>
          </div>
        </div>
      }
    >
      <DashboardData />
    </Suspense>
  );
}
