import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ChevronRight } from "lucide-react";
import {
  EvaluationDetailView,
  type EvaluationMetricDto,
} from "@/components/evaluation/evaluation-detail-view";
import { getCurrentUser } from "@/lib/auth/session";
import { resolveOrNotFound } from "@/lib/not-found";
import {
  getEvaluationBatch,
  getEvaluationMetrics,
  listEvaluationCases,
} from "@/modules/evaluation/evaluation.service";

export const metadata: Metadata = {
  title: "Evaluation",
};

/**
 * Batch detail.
 *
 * The server resolves the batch, its case page and its metrics (all
 * ownership-scoped); the client view polls while the batch is still running.
 */
async function EvaluationData({ id }: { id: string }) {
  const user = await getCurrentUser();
  const [detail, cases, metrics] = await resolveOrNotFound(() =>
    Promise.all([
      getEvaluationBatch(user, id),
      listEvaluationCases(user, id, { status: undefined, limit: 200 }),
      getEvaluationMetrics(user, id),
    ]),
  );

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-10">
      <nav className="flex items-center gap-1 text-xs text-muted-foreground" aria-label="Breadcrumb">
        <Link href="/dashboard/evaluations" className="hover:text-foreground">
          Evaluations
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="font-mono font-medium text-foreground">#{id.slice(-6)}</span>
      </nav>

      <EvaluationDetailView
        batchId={id}
        initial={{
          detail: {
            batch: {
              id: detail.batch.id,
              label: detail.batch.label,
              status: detail.batch.status,
              scoringPolicy: detail.batch.scoringPolicy,
              passThreshold: detail.batch.passThreshold,
              caseCount: detail.batch.caseCount,
              completedCount: detail.batch.completedCount,
              failedCount: detail.batch.failedCount,
              harnessSnapshot: detail.batch.harnessSnapshot,
              datasetId: detail.batch.datasetId,
              datasetVersionId: detail.batch.datasetVersionId,
              datasetSnapshot: detail.batch.datasetSnapshot,
              evaluatorConfig: detail.batch.evaluatorConfig.map((assignment) => ({
                key: assignment.key,
                evaluatorId: assignment.evaluatorId,
                evaluatorVersion: assignment.evaluatorVersion,
                kind: assignment.kind,
                name: assignment.name,
                weight: assignment.weight,
                usesLlm: assignment.usesLlm,
              })),
              config: detail.batch.config,
              cancelRequestedAt: detail.batch.cancelRequestedAt?.toISOString() ?? null,
              startedAt: detail.batch.startedAt?.toISOString() ?? null,
              completedAt: detail.batch.completedAt?.toISOString() ?? null,
              createdAt: detail.batch.createdAt.toISOString(),
            },
            progress: detail.progress,
            agent: detail.agent,
            harness: detail.harness,
            dataset: detail.dataset,
          },
          cases: {
            cases: cases.cases.map((entry) => ({
              id: entry.id,
              caseKey: entry.caseKey,
              index: entry.index,
              name: entry.name,
              status: entry.status,
              runId: entry.runId,
              inputPreview: entry.inputPreview,
              expectedOutput: entry.expectedOutput,
              tags: entry.tags,
              aggregateScore: entry.aggregateScore,
              aggregateStatus: entry.aggregateStatus,
              error: entry.error,
              attempts: entry.attempts,
              passed: entry.passed,
              results: entry.results.map((result) => ({
                id: result.id,
                evaluatorKey: result.evaluatorKey,
                evaluatorName: result.evaluatorName,
                kind: result.kind,
                status: result.status,
                score: result.score,
                maxScore: result.maxScore,
                normalizedScore: result.normalizedScore,
                passed: result.passed,
                explanation: result.explanation,
                evidence: result.evidence,
                durationMs: result.durationMs,
              })),
            })),
            total: cases.total,
            limit: cases.limit,
            offset: cases.offset,
          },
          metrics: metrics as EvaluationMetricDto,
        }}
      />
    </main>
  );
}

export default function EvaluationDetailPage({ params }: PageProps<"/dashboard/evaluations/[id]">) {
  return (
    <Suspense
      fallback={
        <main className="mx-auto w-full max-w-7xl px-6 py-10 text-sm text-muted-foreground">
          Loading evaluation…
        </main>
      }
    >
      <EvaluationIdResolver params={params} />
    </Suspense>
  );
}

async function EvaluationIdResolver({
  params,
}: {
  params: PageProps<"/dashboard/evaluations/[id]">["params"];
}) {
  const { id } = await params;
  return <EvaluationData id={id} />;
}
