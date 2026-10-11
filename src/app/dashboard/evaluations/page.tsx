import type { Metadata } from "next";
import { Suspense } from "react";
import { DashboardNav } from "@/components/dashboard-nav";
import { EvaluationsView, type BatchRowDto } from "@/components/evaluation/evaluations-view";
import { getCurrentUser } from "@/lib/auth/session";
import { listEvaluationBatches } from "@/modules/evaluation/evaluation.service";
import { listProjects } from "@/modules/projects/project.service";

export const metadata: Metadata = {
  title: "Evaluations",
};

/**
 * The run lab's list: every evaluation batch the caller may see.
 *
 * A batch is a sealed experiment (harness version × dataset version × evaluator
 * revisions) that executes case by case through the ordinary runtime.
 */
async function EvaluationsData() {
  const user = await getCurrentUser();
  const [projects, page] = await Promise.all([
    listProjects(user),
    listEvaluationBatches(user, { status: undefined, limit: 50 }),
  ]);

  const batches: BatchRowDto[] = page.items.map((batch) => ({
    id: batch.id,
    label: batch.label,
    status: batch.status,
    harnessId: batch.harnessId,
    harnessName: batch.harnessName,
    harnessVersionLabel: batch.harnessVersionLabel,
    datasetId: batch.datasetId,
    datasetName: batch.datasetName,
    datasetVersion: batch.datasetVersion,
    caseCount: batch.caseCount,
    completedCount: batch.completedCount,
    failedCount: batch.failedCount,
    meanScore: batch.meanScore,
    passRate: batch.passRate,
    costUsd: batch.costUsd,
    costKind: batch.costKind,
    createdAt: batch.createdAt.toISOString(),
    startedAt: batch.startedAt?.toISOString() ?? null,
    completedAt: batch.completedAt?.toISOString() ?? null,
  }));

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-10">
      <DashboardNav current="/dashboard/evaluations" />

      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Evaluations</h1>
        <p className="text-sm text-muted-foreground">
          Run a harness version against a dataset version, scored by pinned evaluator revisions.
          Compare two batches to see regressions before promoting a change.
        </p>
      </header>

      <EvaluationsView
        projects={projects.map((project) => ({ id: project.id, name: project.name }))}
        initialBatches={batches}
      />
    </main>
  );
}

export default function EvaluationsPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto w-full max-w-7xl px-6 py-10 text-sm text-muted-foreground">
          Loading evaluations…
        </main>
      }
    >
      <EvaluationsData />
    </Suspense>
  );
}
