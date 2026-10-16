import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ChevronRight } from "lucide-react";
import {
  ExperimentDetailView,
  type ExperimentDetailDto,
} from "@/components/experiments/experiment-detail-view";
import { getCurrentUser } from "@/lib/auth/session";
import { resolveOrNotFound } from "@/lib/not-found";
import {
  getExperiment,
  getExperimentMetricsView,
} from "@/modules/experiments/experiment.service";

export const metadata: Metadata = {
  title: "Experiment",
};

/**
 * Experiment detail.
 *
 * The server resolves the experiment, its candidate metrics and the ranking
 * (ownership-scoped, from persisted case rows); the client view polls while the
 * experiment is active and offers the lifecycle actions its status allows.
 */
async function ExperimentData({ id }: { id: string }) {
  const user = await getCurrentUser();
  const [detail, metricsView] = await resolveOrNotFound(() =>
    Promise.all([
      getExperiment(user, id),
      getExperimentMetricsView(user, id, { withAnalysis: false }),
    ]),
  );

  const record = detail.experiment;
  const snapshot = record.configSnapshot;

  const dto: ExperimentDetailDto = {
    experiment: {
      id: record.id,
      name: record.name,
      description: record.description,
      hypothesis: record.hypothesis,
      status: record.status,
      passThreshold: record.passThreshold,
      scoringPolicy: record.scoringPolicy,
      caseCount: record.caseCount,
      plannedRunCount: record.plannedRunCount,
      objective: record.objective,
      startedAt: record.startedAt?.toISOString() ?? null,
      completedAt: record.completedAt?.toISOString() ?? null,
      pausedAt: record.pausedAt?.toISOString() ?? null,
      cancelRequestedAt: record.cancelRequestedAt?.toISOString() ?? null,
      selectedCandidateId: record.selectedCandidateId,
      selectionKind: record.selectionKind,
      selectionNotes: record.selectionNotes,
      promotedCandidateId: record.promotedCandidateId,
      promotionNotes: record.promotionNotes,
      reproducibilityNotes: snapshot?.reproducibilityNotes ?? [],
      engineVersion: snapshot?.runtimeEngineVersion ?? "—",
      pricingVersion: snapshot?.pricingVersion ?? "—",
      harnessVersions: detail.candidates.map((candidate) => ({
        label: candidate.label,
        role: candidate.role,
        harnessVersionId: candidate.harnessVersionId,
        harnessVersion: candidate.harnessVersion,
      })),
    },
    progress: detail.progress,
    agent: detail.agent,
    dataset:
      detail.dataset === null
        ? null
        : { id: detail.dataset.id, name: detail.dataset.name, version: detail.dataset.version },
    candidates: detail.candidates,
    evaluators: detail.evaluators.map((evaluator) => ({
      key: evaluator.key,
      name: evaluator.name,
      kind: evaluator.kind,
      version: evaluator.version,
      weight: evaluator.weight,
    })),
    metrics: record.metrics,
    ranking: metricsView.ranking,
    constraintStatus: metricsView.constraintStatus,
  };

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-10">
      <nav className="flex items-center gap-1 text-xs text-muted-foreground" aria-label="Breadcrumb">
        <Link href="/dashboard/experiments" className="hover:text-foreground">
          Experiments
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="font-mono font-medium text-foreground">#{id.slice(-6)}</span>
      </nav>

      <ExperimentDetailView initial={dto} />
    </main>
  );
}

export default function ExperimentDetailPage({ params }: PageProps<"/dashboard/experiments/[id]">) {
  return (
    <Suspense
      fallback={
        <main className="mx-auto w-full max-w-7xl px-6 py-10 text-sm text-muted-foreground">
          Loading experiment…
        </main>
      }
    >
      <ExperimentIdResolver params={params} />
    </Suspense>
  );
}

async function ExperimentIdResolver({
  params,
}: {
  params: PageProps<"/dashboard/experiments/[id]">["params"];
}) {
  const { id } = await params;
  return <ExperimentData id={id} />;
}
