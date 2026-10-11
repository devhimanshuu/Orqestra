import type { Metadata } from "next";
import { Suspense } from "react";
import { DashboardNav } from "@/components/dashboard-nav";
import { DatasetsView, type DatasetRowDto } from "@/components/evaluation/datasets-view";
import { getCurrentUser } from "@/lib/auth/session";
import { listDatasets } from "@/modules/evaluation/dataset.service";
import { listProjects } from "@/modules/projects/project.service";

export const metadata: Metadata = {
  title: "Datasets",
};

/**
 * Datasets: the versioned corpora evaluations run against.
 *
 * The server resolves the caller's projects and datasets (ownership-scoped) and
 * hands serializable rows to the client view.
 */
async function DatasetsData() {
  const user = await getCurrentUser();
  const [projects, page] = await Promise.all([listProjects(user), listDatasets(user, {})]);

  const datasets: DatasetRowDto[] = page.datasets.map((dataset) => ({
    id: dataset.id,
    projectId: dataset.projectId,
    name: dataset.name,
    slug: dataset.slug,
    description: dataset.description,
    currentVersion: dataset.currentVersion,
    caseCount: dataset.caseCount,
    versionCount: dataset.versionCount,
    batchCount: dataset.batchCount,
    updatedAt: dataset.updatedAt.toISOString(),
  }));

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10">
      <DashboardNav current="/dashboard/datasets" />

      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Datasets</h1>
        <p className="text-sm text-muted-foreground">
          A dataset is a versioned set of test cases. Its working set is editable; published
          versions are immutable and content-hashed — that is what an evaluation pins.
        </p>
      </header>

      <DatasetsView
        projects={projects.map((project) => ({ id: project.id, name: project.name }))}
        initialDatasets={datasets}
      />
    </main>
  );
}

export default function DatasetsPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto w-full max-w-6xl px-6 py-10 text-sm text-muted-foreground">
          Loading datasets…
        </main>
      }
    >
      <DatasetsData />
    </Suspense>
  );
}
