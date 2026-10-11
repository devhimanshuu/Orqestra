import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ChevronRight } from "lucide-react";
import { DashboardNav } from "@/components/dashboard-nav";
import { EvaluatorDetailView, type EvaluatorDetailDto } from "@/components/evaluation/evaluator-detail-view";
import { getCurrentUser } from "@/lib/auth/session";
import { evaluatorRepository } from "@/modules/evaluation/evaluator.repository";
import { getEvaluator, listKinds } from "@/modules/evaluation/evaluator.service";
import type { EvaluatorKind } from "@/modules/evaluation/evaluation.types";

export const metadata: Metadata = {
  title: "Evaluator",
};

async function EvaluatorData({ id }: { id: string }) {
  const user = await getCurrentUser();
  const evaluator = await getEvaluator(user, id);
  const versions = await evaluatorRepository.listVersions(evaluator.id);
  const kindInfo = listKinds().find((entry) => entry.kind === (evaluator.kind as EvaluatorKind)) ?? null;

  const initial: EvaluatorDetailDto = {
    id: evaluator.id,
    projectId: evaluator.projectId,
    name: evaluator.name,
    slug: evaluator.slug,
    description: evaluator.description,
    kind: evaluator.kind,
    enabled: evaluator.enabled,
    currentVersion: evaluator.currentVersion,
    versionCount: evaluator.versionCount,
    updatedAt: evaluator.updatedAt.toISOString(),
    current: {
      id: evaluator.current.id,
      version: evaluator.current.version,
      name: evaluator.current.name,
      kind: evaluator.current.kind,
      description: evaluator.current.description,
      config: evaluator.current.config,
      weight: evaluator.current.weight,
      contentHash: evaluator.current.contentHash,
      createdAt: evaluator.current.createdAt.toISOString(),
    },
    versions: versions.map((version) => ({
      id: version.id,
      version: version.version,
      name: version.name,
      kind: version.kind,
      description: version.description,
      config: version.config,
      weight: version.weight,
      contentHash: version.contentHash,
      createdAt: version.createdAt.toISOString(),
    })),
  };

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10">
      <DashboardNav current="/dashboard/evaluators" />
      <nav className="flex items-center gap-1 text-xs text-muted-foreground" aria-label="Breadcrumb">
        <Link href="/dashboard/evaluators" className="hover:text-foreground">
          Evaluators
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="font-medium text-foreground">{evaluator.name}</span>
      </nav>

      <EvaluatorDetailView
        initial={initial}
        kindInfo={
          kindInfo === null
            ? null
            : {
                label: kindInfo.label,
                description: kindInfo.description,
                usesLlm: kindInfo.usesLlm,
                configFields: kindInfo.configFields,
              }
        }
      />
    </main>
  );
}

export default function EvaluatorDetailPage({ params }: PageProps<"/dashboard/evaluators/[id]">) {
  return (
    <Suspense
      fallback={
        <main className="mx-auto w-full max-w-6xl px-6 py-10 text-sm text-muted-foreground">
          Loading evaluator…
        </main>
      }
    >
      <EvaluatorIdResolver params={params} />
    </Suspense>
  );
}

async function EvaluatorIdResolver({
  params,
}: {
  params: PageProps<"/dashboard/evaluators/[id]">["params"];
}) {
  const { id } = await params;
  return <EvaluatorData id={id} />;
}
