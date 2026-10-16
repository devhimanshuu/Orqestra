import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ChevronRight } from "lucide-react";
import {
  ExperimentComparisonView,
  type ExperimentComparisonDto,
} from "@/components/experiments/comparison-view";
import { getCurrentUser } from "@/lib/auth/session";
import { resolveOrNotFound } from "@/lib/not-found";
import { compareExperiment } from "@/modules/experiments/experiment.service";

export const metadata: Metadata = {
  title: "Compare experiment candidates",
};

/**
 * Candidate comparison.
 *
 * The server computes the comparison once (aligned per-case evidence, constraint
 * status, regression findings) and the client view re-reads it while the
 * experiment is still running. Per-case results are a window over the aligned
 * cases, and the view says so instead of implying it saw everything.
 */
async function ComparisonData({ id }: { id: string }) {
  const user = await getCurrentUser();
  const comparison = await resolveOrNotFound(() =>
    compareExperiment(user, id, {
      candidateId: undefined,
      baselineCandidateId: undefined,
      includeCases: true,
      regressionsOnly: false,
    }),
  );

  const dto: ExperimentComparisonDto = {
    experiment: {
      id: comparison.experiment.id,
      name: comparison.experiment.name,
      status: comparison.experiment.status,
      objective: {
        primary: {
          metric: comparison.experiment.objective.primary.metric,
          direction: comparison.experiment.objective.primary.direction,
        },
        secondary: comparison.experiment.objective.secondary.map((entry) => ({
          metric: entry.metric,
          direction: entry.direction,
        })),
      },
      passThreshold: comparison.experiment.passThreshold,
      selectedCandidateId: comparison.experiment.selectedCandidateId,
      promotedCandidateId: comparison.experiment.promotedCandidateId,
    },
    baselineCandidateId: comparison.baselineCandidateId,
    baseline:
      comparison.baseline === null
        ? null
        : { label: comparison.baseline.metrics.label, metrics: comparison.baseline.metrics },
    candidates: comparison.candidates.map((entry) => ({
      id: entry.metrics.candidateId,
      label: entry.metrics.label,
      role: entry.metrics.role,
      harnessVersion: entry.metrics.harnessVersion,
      side: {
        metrics: entry.metrics,
        constraints: entry.constraints,
        primary: entry.primary,
        secondary: entry.secondary,
        regressions: entry.regressions,
        pathChanges: entry.pathChanges,
        notes: entry.notes,
        rank: entry.rank,
        eligibleForWin: entry.eligibleForWin,
        winBlockers: entry.winBlockers,
        reasons: entry.reasons,
        evidence: entry.analysis?.evidence ?? null,
        paired: entry.analysis?.evidence.paired ?? null,
        signTest: entry.analysis?.evidence.signTest ?? null,
      },
    })),
    ranking: {
      leader: comparison.ranking.leader,
      leaderNote: comparison.ranking.leaderNote,
      settled: comparison.ranking.settled,
      notes: comparison.ranking.notes,
    },
    cases: comparison.cases,
    // The service caps the per-case window; the dataset snapshot is the number of
    // aligned cases the experiment sealed, so the window is stated, not implied.
    casesTruncated: comparison.experiment.datasetSnapshot.length > comparison.cases.length,
    caseTotal: comparison.experiment.datasetSnapshot.length,
  };

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-10">
      <nav className="flex items-center gap-1 text-xs text-muted-foreground" aria-label="Breadcrumb">
        <Link href="/dashboard/experiments" className="hover:text-foreground">
          Experiments
        </Link>
        <ChevronRight className="h-3 w-3" />
        <Link href={`/dashboard/experiments/${id}`} className="hover:text-foreground">
          #{id.slice(-6)}
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="font-medium text-foreground">Compare</span>
      </nav>

      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{comparison.experiment.name}</h1>
        <p className="text-sm text-muted-foreground">
          Baseline and candidates side by side. Differences are shown against the baseline; percentage
          changes appear only where the baseline value makes them meaningful.
        </p>
      </header>

      <ExperimentComparisonView experimentId={id} initial={dto} />
    </main>
  );
}

export default function CompareExperimentPage({
  params,
}: PageProps<"/dashboard/experiments/[id]/compare">) {
  return (
    <Suspense
      fallback={
        <main className="mx-auto w-full max-w-7xl px-6 py-10 text-sm text-muted-foreground">
          Loading comparison…
        </main>
      }
    >
      <ComparisonResolver params={params} />
    </Suspense>
  );
}

async function ComparisonResolver({
  params,
}: {
  params: PageProps<"/dashboard/experiments/[id]/compare">["params"];
}) {
  const { id } = await params;
  return <ComparisonData id={id} />;
}
