import type { Metadata } from "next";
import { Suspense } from "react";
import { DashboardNav } from "@/components/dashboard-nav";
import { ExperimentsView, type ExperimentRowDto } from "@/components/experiments/experiments-view";
import { getCurrentUser } from "@/lib/auth/session";
import { listExperiments } from "@/modules/experiments/experiment.service";
import { listProjects } from "@/modules/projects/project.service";

export const metadata: Metadata = {
  title: "Experiments",
};

/**
 * Phase 4's front door: every experiment the caller may see.
 *
 * An experiment compares immutable harness versions over one dataset version with
 * one objective and one set of constraints. The leading candidate shown here comes
 * from the stored metrics and the configured ranking rules — never from a
 * hardcoded threshold — and the list makes no statistical claim, because it has no
 * per-case data.
 */
async function ExperimentsData() {
  const user = await getCurrentUser();
  const [projects, page] = await Promise.all([
    listProjects(user),
    listExperiments(user, { status: undefined, sort: "createdAt", order: "desc", limit: 50 }),
  ]);

  const rows: ExperimentRowDto[] = page.items.map((item) => ({
    id: item.id,
    name: item.name,
    status: item.status,
    agentName: item.agentName,
    candidateCount: item.candidateCount,
    caseCount: item.caseCount,
    plannedRunCount: item.plannedRunCount,
    datasetName: item.datasetName,
    datasetVersion: item.datasetVersion,
    baselineHarnessVersion: item.baselineHarnessVersion,
    primaryMetric: item.primaryMetric,
    primaryDirection: item.primaryDirection,
    leadingCandidateLabel: item.leadingCandidateLabel,
    leaderNote: item.leaderNote,
    completedExecutions: item.completedExecutions,
    failedExecutions: item.failedExecutions,
    createdAt: item.createdAt.toISOString(),
    startedAt: item.startedAt?.toISOString() ?? null,
    completedAt: item.completedAt?.toISOString() ?? null,
  }));

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-10">
      <DashboardNav current="/dashboard/experiments" />

      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Experiments</h1>
        <p className="text-sm text-muted-foreground">
          Compare a baseline harness version against one or more candidates over the same dataset
          version, under the same evaluators, ranked by an explicit objective and hard constraints.
        </p>
      </header>

      <ExperimentsView
        projects={projects.map((project) => ({ id: project.id, name: project.name }))}
        initialExperiments={rows}
      />
    </main>
  );
}

export default function ExperimentsPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto w-full max-w-7xl px-6 py-10 text-sm text-muted-foreground">
          Loading experiments…
        </main>
      }
    >
      <ExperimentsData />
    </Suspense>
  );
}
