import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ChevronRight } from "lucide-react";
import { DashboardNav } from "@/components/dashboard-nav";
import { DatasetDetailView, type DatasetDetailDto } from "@/components/evaluation/dataset-detail-view";
import { getCurrentUser } from "@/lib/auth/session";
import { getDatasetDetail } from "@/modules/evaluation/dataset.service";

export const metadata: Metadata = {
  title: "Dataset",
};

async function DatasetData({ id }: { id: string }) {
  const user = await getCurrentUser();
  const detail = await getDatasetDetail(user, id);

  const initial: DatasetDetailDto = {
    id: detail.id,
    projectId: detail.projectId,
    name: detail.name,
    slug: detail.slug,
    description: detail.description,
    currentVersion: detail.currentVersion,
    caseCount: detail.caseCount,
    cases: detail.cases.map((entry) => ({
      id: entry.id,
      caseKey: entry.caseKey,
      name: entry.name,
      input: entry.input,
      expectedOutput: entry.expectedOutput,
      metadata: entry.metadata,
      tags: entry.tags,
      updatedAt: entry.updatedAt.toISOString(),
    })),
    versions: detail.versions.map((version) => ({
      id: version.id,
      version: version.version,
      name: version.name,
      caseCount: version.caseCount,
      contentHash: version.contentHash,
      createdAt: version.createdAt.toISOString(),
    })),
  };

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10">
      <DashboardNav current="/dashboard/datasets" />
      <nav className="flex items-center gap-1 text-xs text-muted-foreground" aria-label="Breadcrumb">
        <Link href="/dashboard/datasets" className="hover:text-foreground">
          Datasets
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="font-medium text-foreground">{detail.name}</span>
      </nav>

      <DatasetDetailView initial={initial} />
    </main>
  );
}

export default function DatasetDetailPage({ params }: PageProps<"/dashboard/datasets/[id]">) {
  return (
    <Suspense
      fallback={
        <main className="mx-auto w-full max-w-6xl px-6 py-10 text-sm text-muted-foreground">
          Loading dataset…
        </main>
      }
    >
      <DatasetIdResolver params={params} />
    </Suspense>
  );
}

async function DatasetIdResolver({
  params,
}: {
  params: PageProps<"/dashboard/datasets/[id]">["params"];
}) {
  const { id } = await params;
  return <DatasetData id={id} />;
}
