"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, ChevronDown, ChevronUp, Download, GitCompare, RefreshCw, RotateCcw } from "lucide-react";
import { api, errorMessage } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { formatDuration, formatRelativeTime } from "@/components/run-status";
import { cn } from "@/lib/utils";
import {
  JsonBlock,
  ScoreBar,
  StatCard,
  StatusChip,
  formatRate,
  formatScore,
  formatUsd,
} from "./shared";

export interface EvaluationResultDto {
  id: string;
  evaluatorKey: string;
  evaluatorName: string;
  kind: string;
  status: string;
  score: number | null;
  maxScore: number;
  normalizedScore: number | null;
  passed: boolean | null;
  explanation: string;
  evidence: unknown;
  durationMs: number | null;
}

export interface EvaluationCaseDto {
  id: string;
  caseKey: string;
  index: number;
  name: string | null;
  status: string;
  runId: string | null;
  inputPreview: string | null;
  expectedOutput: unknown;
  tags: string[];
  aggregateScore: number | null;
  aggregateStatus: string | null;
  error: unknown;
  attempts: number;
  results: EvaluationResultDto[];
  passed: boolean | null;
}

export interface EvaluationMetricDto {
  cases: {
    total: number;
    completed: number;
    failed: number;
    skipped: number;
    cancelled: number;
    pending: number;
    running: number;
  };
  scored: number;
  unscored: number;
  aggregateStatuses: { complete: number; incomplete: number; failed: number };
  score: { mean: number | null; median: number | null };
  passRate: number | null;
  passed: number;
  failed: number;
  latency: { averageMs: number | null; medianMs: number | null; measured: number };
  tokens: { total: number; reported: number; unreported: number };
  cost: {
    costUsd: number | null;
    /** True when every contributing call was priced. */
    complete: boolean;
    /** Models that could not be priced. */
    unpriced: string[];
    sources: string[];
    kind: "estimated";
  };
  retries: number;
  toolInvocations: number;
  perEvaluator: Array<{
    evaluatorKey: string;
    evaluatorName: string;
    kind: string;
    scored: number;
    errors: number;
    skipped: number;
    meanScore: number | null;
    passRate: number | null;
    meanDurationMs: number | null;
  }>;
  evaluatorUsage: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsd: number | null;
    unknownCost: boolean;
  };
}

export interface BatchDetailDto {
  id: string;
  label: string | null;
  status: string;
  scoringPolicy: string;
  passThreshold: number | null;
  caseCount: number;
  completedCount: number;
  failedCount: number;
  harnessSnapshot: {
    harnessId: string;
    harnessVersion: number;
    harnessName: string;
    contentHash: string;
    entryNode: string;
    nodeCount: number;
    edgeCount: number;
  };
  datasetId: string;
  datasetVersionId: string;
  datasetSnapshot: unknown[];
  evaluatorConfig: Array<{
    key: string;
    evaluatorId: string;
    evaluatorVersion: number;
    kind: string;
    name: string;
    weight: number;
    usesLlm: boolean;
  }>;
  config: { concurrency: number; limits: unknown };
  cancelRequestedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

interface BatchDetailResponse {
  batch: BatchDetailDto;
  progress: {
    status: string;
    caseCount: number;
    completedCount: number;
    failedCount: number;
    pending: number;
    running: number;
    cancelled: number;
    percent: number;
    cancellable: boolean;
  };
  agent: { id: string; name: string } | null;
  harness: { id: string; name: string; slug: string } | null;
  dataset: { id: string; name: string; slug: string; version: number } | null;
}

interface CasesResponse {
  cases: EvaluationCaseDto[];
  total: number;
  limit: number;
  offset: number;
}

function isActive(status: string): boolean {
  return status === "PENDING" || status === "RUNNING";
}

/**
 * Batch detail: live progress, batch metrics, and every case with its verdicts.
 *
 * Everything shown is derived from persisted rows (the server recomputes
 * progress and metrics on read), so a refresh during a run is never ahead of or
 * behind the truth.
 */
export function EvaluationDetailView({
  batchId,
  initial,
}: {
  batchId: string;
  initial: {
    detail: BatchDetailResponse;
    cases: CasesResponse;
    metrics: EvaluationMetricDto;
  };
}) {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const detailQuery = useQuery({
    queryKey: ["evaluation", batchId],
    queryFn: () => api.get<BatchDetailResponse>(`/api/evaluations/${batchId}`),
    initialData: initial.detail,
    refetchInterval: (query) =>
      isActive(query.state.data?.batch.status ?? "COMPLETED") ? 3_000 : false,
  });
  const active = isActive(detailQuery.data.batch.status);

  const casesQuery = useQuery({
    queryKey: ["evaluation-cases", batchId, statusFilter],
    queryFn: () =>
      api.get<CasesResponse>(
        `/api/evaluations/${batchId}/cases?limit=200${statusFilter !== "" ? `&status=${statusFilter}` : ""}`,
      ),
    initialData: statusFilter === "" ? initial.cases : undefined,
    refetchInterval: active ? 3_000 : false,
  });

  const metricsQuery = useQuery({
    queryKey: ["evaluation-metrics", batchId],
    queryFn: () => api.get<{ metrics: EvaluationMetricDto }>(`/api/evaluations/${batchId}/metrics`),
    initialData: { metrics: initial.metrics },
    refetchInterval: active ? 3_000 : false,
  });

  const detail = detailQuery.data;
  const metrics = metricsQuery.data.metrics;
  const cases = casesQuery.data?.cases ?? [];

  const cancel = useMutation({
    mutationFn: () => api.post<{ batch: { status: string }; runningCases: number }>(`/api/evaluations/${batchId}/cancel`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["evaluation", batchId] });
      void queryClient.invalidateQueries({ queryKey: ["evaluation-cases", batchId] });
      void queryClient.invalidateQueries({ queryKey: ["evaluations"] });
    },
  });

  const retryCase = useMutation({
    mutationFn: (caseKey: string) =>
      api.post(`/api/evaluations/${batchId}/cases/${encodeURIComponent(caseKey)}`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["evaluation", batchId] });
      void queryClient.invalidateQueries({ queryKey: ["evaluation-cases", batchId] });
      void queryClient.invalidateQueries({ queryKey: ["evaluation-metrics", batchId] });
    },
  });

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {detail.batch.label ?? `Evaluation #${batchId.slice(-6)}`}
            </h1>
            <StatusChip value={detail.batch.status} />
            {active ? (
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <RefreshCw className="h-3 w-3 animate-spin" /> live
              </span>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {detail.harness?.name ?? detail.batch.harnessSnapshot.harnessName} v
            {detail.batch.harnessSnapshot.harnessVersion} against {detail.dataset?.name ?? "dataset"} v
            {detail.dataset?.version ?? "?"} — {detail.batch.caseCount} case
            {detail.batch.caseCount === 1 ? "" : "s"}
            {detail.agent !== null ? `, agent ${detail.agent.name}` : ""}.
          </p>
          <p className="font-mono text-[10.5px] text-muted-foreground">
            started {detail.batch.startedAt !== null ? formatRelativeTime(detail.batch.startedAt) : "—"} ·
            content hash {detail.batch.harnessSnapshot.contentHash.slice(0, 12)}… · policy{" "}
            {detail.batch.scoringPolicy}
            {detail.batch.passThreshold !== null ? ` · pass mark ${detail.batch.passThreshold}` : ""}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {detail.progress.cancellable ? (
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs text-destructive hover:text-destructive"
              disabled={cancel.isPending}
              onClick={() => {
                if (window.confirm("Cancel this evaluation? Results already produced are kept.")) {
                  cancel.mutate();
                }
              }}
              data-testid="evaluation-cancel"
            >
              <Ban className="h-3.5 w-3.5" />
              {cancel.isPending ? "Cancelling…" : "Cancel"}
            </Button>
          ) : null}
          <Button asChild variant="outline" size="sm" className="h-8 gap-1.5 text-xs">
            <a href={`/api/evaluations/${batchId}/export`} download>
              <Download className="h-3.5 w-3.5" />
              Export report
            </a>
          </Button>
        </div>
      </div>

      {cancel.isError ? <p className="text-xs text-destructive">{errorMessage(cancel.error)}</p> : null}

      <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {detail.progress.completedCount} completed · {detail.progress.failedCount} failed ·{" "}
            {detail.progress.running} running · {detail.progress.pending} pending
            {detail.progress.cancelled > 0 ? ` · ${detail.progress.cancelled} cancelled` : ""}
          </span>
          <span className="font-mono">{Math.round(detail.progress.percent * 100)}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              detail.progress.failedCount > 0 ? "bg-amber-500" : "bg-emerald-500",
            )}
            style={{ width: `${Math.round(detail.progress.percent * 100)}%` }}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label="Mean score"
          value={formatScore(metrics.score.mean)}
          hint={metrics.score.median !== null ? `median ${formatScore(metrics.score.median)}` : undefined}
        />
        <StatCard
          label="Pass rate"
          value={formatRate(metrics.passRate)}
          hint={`${metrics.passed} passed · ${metrics.failed} failed`}
        />
        <StatCard
          label="Scored cases"
          value={`${metrics.scored}/${metrics.cases.total}`}
          hint={`${metrics.unscored} without a score`}
        />
        <StatCard
          label="Avg latency"
          value={formatDuration(metrics.latency.averageMs)}
          hint={`over ${metrics.latency.measured} run(s)`}
        />
        <StatCard
          label="Tokens"
          value={metrics.tokens.total.toLocaleString()}
          hint={`reported by ${metrics.tokens.reported}/${metrics.cases.total} runs`}
        />
        <StatCard
          label="Estimated cost"
          value={formatUsd(metrics.cost.costUsd)}
          hint={
            metrics.cost.complete
              ? `${metrics.cost.sources.join(", ") || "estimated"} pricing`
              : `${metrics.cost.unpriced.length} unpriced model(s)`
          }
        />
      </div>

      {metrics.perEvaluator.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Per-evaluator results</h2>
          <div className="overflow-hidden rounded-lg border">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Evaluator</th>
                  <th className="px-3 py-2 font-medium">Kind</th>
                  <th className="px-3 py-2 font-medium">Scored</th>
                  <th className="px-3 py-2 font-medium">Errors</th>
                  <th className="px-3 py-2 font-medium">Skipped</th>
                  <th className="px-3 py-2 font-medium">Mean</th>
                  <th className="px-3 py-2 font-medium">Pass rate</th>
                  <th className="px-3 py-2 font-medium">Avg time</th>
                </tr>
              </thead>
              <tbody>
                {metrics.perEvaluator.map((entry) => (
                  <tr key={entry.evaluatorKey} className="border-b last:border-b-0">
                    <td className="px-3 py-2 text-xs font-medium">{entry.evaluatorName}</td>
                    <td className="px-3 py-2 font-mono text-[10.5px] text-muted-foreground">{entry.kind}</td>
                    <td className="px-3 py-2 font-mono text-xs">{entry.scored}</td>
                    <td className={cn("px-3 py-2 font-mono text-xs", entry.errors > 0 && "text-destructive")}>
                      {entry.errors}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{entry.skipped}</td>
                    <td className="px-3 py-2">
                      <ScoreBar value={entry.meanScore} />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{formatRate(entry.passRate)}</td>
                    <td className="px-3 py-2 font-mono text-xs">{formatDuration(entry.meanDurationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {metrics.evaluatorUsage.calls > 0 ? (
            <p className="text-xs text-muted-foreground">
              LLM judges: {metrics.evaluatorUsage.calls} call(s),{" "}
              {metrics.evaluatorUsage.totalTokens.toLocaleString()} tokens,{" "}
              {formatUsd(metrics.evaluatorUsage.costUsd)} — kept apart from the agent runs they judged.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Cases</h2>
            <p className="text-xs text-muted-foreground">
              {cases.length} shown — each case links to the run it produced.
            </p>
          </div>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            data-testid="evaluation-case-filter"
            className="h-8 rounded-md border bg-transparent px-2 text-xs shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
          >
            <option value="">All statuses</option>
            <option value="COMPLETED">Completed</option>
            <option value="FAILED">Failed</option>
            <option value="CANCELLED">Cancelled</option>
            <option value="PENDING">Pending</option>
            <option value="RUNNING">Running</option>
          </select>
        </div>

        <div className="overflow-hidden rounded-lg border" data-testid="evaluation-cases">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Case</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Score</th>
                <th className="px-3 py-2 font-medium">Verdict</th>
                <th className="px-3 py-2 font-medium">Run</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {cases.map((entry) => (
                <CaseRow
                  key={entry.id}
                  entry={entry}
                  batchId={batchId}
                  expanded={expanded === entry.id}
                  onToggle={() => setExpanded(expanded === entry.id ? null : entry.id)}
                  onRetry={() => retryCase.mutate(entry.caseKey)}
                  retrying={retryCase.isPending}
                />
              ))}
            </tbody>
          </table>
        </div>
        {casesQuery.isError ? (
          <p className="text-xs text-destructive">{errorMessage(casesQuery.error)}</p>
        ) : null}
      </section>

      <nav className="flex items-center gap-1 text-xs text-muted-foreground">
        <Link href="/dashboard/evaluations" className="hover:text-foreground">
          ← All evaluations
        </Link>
        <span className="mx-1">·</span>
        <Link
          href={`/dashboard/evaluations/compare?baseline=${batchId}`}
          className="inline-flex items-center gap-1 hover:text-foreground"
        >
          <GitCompare className="h-3 w-3" />
          Compare this evaluation
        </Link>
      </nav>
    </div>
  );
}

function CaseRow({
  entry,
  batchId,
  expanded,
  onToggle,
  onRetry,
  retrying,
}: {
  entry: EvaluationCaseDto;
  batchId: string;
  expanded: boolean;
  onToggle: () => void;
  onRetry: () => void;
  retrying: boolean;
}) {
  const retryable = entry.status === "FAILED" || entry.status === "CANCELLED";
  return (
    <>
      <tr className="border-b last:border-b-0 hover:bg-muted/30">
        <td className="px-3 py-2">
          <button type="button" onClick={onToggle} className="flex items-center gap-1.5 text-left">
            {expanded ? <ChevronUp className="h-3 w-3 text-muted-foreground" /> : <ChevronDown className="h-3 w-3 text-muted-foreground" />}
            <span className="flex flex-col">
              <span className="font-mono text-xs font-medium">{entry.caseKey}</span>
              {entry.name !== null ? (
                <span className="text-[10.5px] text-muted-foreground">{entry.name}</span>
              ) : null}
            </span>
          </button>
        </td>
        <td className="px-3 py-2">
          <StatusChip value={entry.status} kind="case" />
        </td>
        <td className="px-3 py-2">
          <ScoreBar value={entry.aggregateScore} />
        </td>
        <td className="px-3 py-2 text-xs">
          {entry.passed === null ? (
            <span className="text-muted-foreground">{entry.aggregateStatus ?? "—"}</span>
          ) : entry.passed ? (
            <span className="text-emerald-700 dark:text-emerald-400">passed</span>
          ) : (
            <span className="text-destructive">failed</span>
          )}
          {entry.attempts > 1 ? (
            <span className="ml-1 text-[10.5px] text-muted-foreground">· {entry.attempts} attempts</span>
          ) : null}
        </td>
        <td className="px-3 py-2">
          {entry.runId !== null ? (
            <Link href={`/dashboard/runs/${entry.runId}`} className="font-mono text-xs hover:underline">
              #{entry.runId.slice(-6)}
            </Link>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </td>
        <td className="px-3 py-2 text-right">
          {retryable ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs"
              disabled={retrying}
              onClick={onRetry}
            >
              <RotateCcw className="h-3 w-3" />
              Retry
            </Button>
          ) : null}
        </td>
      </tr>
      {expanded ? (
        <tr className="border-b bg-muted/20 last:border-b-0">
          <td colSpan={6} className="px-4 py-3">
            <div className="flex flex-col gap-3">
              {entry.error !== null ? (
                <div>
                  <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-destructive">
                    Case failure
                  </p>
                  <JsonBlock value={entry.error} />
                </div>
              ) : null}

              {entry.results.length === 0 ? (
                <p className="text-xs text-muted-foreground">No evaluator verdicts were recorded.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {entry.results.map((result) => (
                    <div key={result.id} className="rounded-md border bg-card p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium">{result.evaluatorName}</span>
                        <StatusChip value={result.status} kind="result" />
                        <span className="font-mono text-[10.5px] text-muted-foreground">{result.kind}</span>
                        <span className="ml-auto font-mono text-xs">
                          {result.score === null
                            ? "no score"
                            : `${result.score}/${result.maxScore}`}
                          {result.durationMs !== null ? ` · ${formatDuration(result.durationMs)}` : ""}
                        </span>
                      </div>
                      <p className="mt-1.5 text-xs text-muted-foreground">{result.explanation}</p>
                      {result.evidence !== null && result.evidence !== undefined ? (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
                            Evidence
                          </summary>
                          <div className="mt-1.5">
                            <JsonBlock value={result.evidence} maxLength={2_000} />
                          </div>
                        </details>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Pinned input preview
                  </p>
                  {entry.inputPreview !== null ? (
                    <p className="font-mono text-[11px] text-muted-foreground">{entry.inputPreview}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground">—</p>
                  )}
                </div>
                <div>
                  <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Expected output
                  </p>
                  <JsonBlock value={entry.expectedOutput} maxLength={1_000} />
                </div>
              </div>
              {entry.runId !== null ? (
                <p className="text-[11px] text-muted-foreground">
                  Batch {batchId.slice(-6)} · run{" "}
                  <Link href={`/dashboard/runs/${entry.runId}`} className="underline hover:text-foreground">
                    #{entry.runId.slice(-6)}
                  </Link>
                </p>
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
