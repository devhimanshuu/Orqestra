import type { Metadata } from "next";
import { Suspense } from "react";
import { DashboardNav } from "@/components/dashboard-nav";
import {
  ComparisonView,
  type ComparableBatchOption,
} from "@/components/evaluation/comparison-view";
import { getCurrentUser } from "@/lib/auth/session";
import { isTerminalBatchStatus } from "@/modules/evaluation/batch.types";
import { listEvaluationBatches } from "@/modules/evaluation/evaluation.service";

export const metadata: Metadata = {
  title: "Compare evaluations",
};

/**
 * Comparison page: pick two settled batches and see the regression list.
 *
 * Only finished batches are offered — comparing against an in-flight run would
 * compare against an unfinished picture. The comparison itself is computed by
 * the API (aligned by stable case key).
 */
async function CompareData({
  baseline,
  candidate,
}: {
  baseline: string;
  candidate: string;
}) {
  const user = await getCurrentUser();
  const page = await listEvaluationBatches(user, { status: undefined, limit: 100 });

  const batches: ComparableBatchOption[] = page.items
    .filter((batch) => isTerminalBatchStatus(batch.status))
    .map((batch) => ({
      id: batch.id,
      label: batch.label,
      status: batch.status,
      harnessName: batch.harnessName,
      harnessVersionLabel: batch.harnessVersionLabel,
      datasetName: batch.datasetName,
      datasetVersion: batch.datasetVersion,
      caseCount: batch.caseCount,
      meanScore: batch.meanScore,
      passRate: batch.passRate,
      createdAt: batch.createdAt.toISOString(),
    }));

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-10">
      <DashboardNav current="/dashboard/evaluations" />

      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Compare evaluations</h1>
        <p className="text-sm text-muted-foreground">
          Aligned by stable test-case key, never by position. Regressions — cases that passed before
          and fail now — are computed directly, not inferred from score averages.
        </p>
      </header>

      <ComparisonView batches={batches} initialBaseline={baseline} initialCandidate={candidate} />
    </main>
  );
}

export default function ComparePage({
  searchParams,
}: PageProps<"/dashboard/evaluations/compare">) {
  return (
    <Suspense
      fallback={
        <main className="mx-auto w-full max-w-7xl px-6 py-10 text-sm text-muted-foreground">
          Loading comparison…
        </main>
      }
    >
      <CompareSearchResolver searchParams={searchParams} />
    </Suspense>
  );
}

async function CompareSearchResolver({
  searchParams,
}: {
  searchParams: PageProps<"/dashboard/evaluations/compare">["searchParams"];
}) {
  const resolved = await searchParams;
  const baseline = typeof resolved.baseline === "string" ? resolved.baseline : "";
  const candidate = typeof resolved.candidate === "string" ? resolved.candidate : "";
  return <CompareData baseline={baseline} candidate={candidate} />;
}
