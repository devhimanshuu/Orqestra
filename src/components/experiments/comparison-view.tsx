"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Download, Rocket, TrendingDown, TrendingUp } from "lucide-react";
import { api, errorMessage, errorMessageWithIssues } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScoreBar } from "@/components/evaluation/shared";
import type { CandidateMetrics } from "@/modules/experiments/experiment.metrics";
import type { ConstraintCheck } from "@/modules/experiments/experiment.objective";
import type { ConstraintEvaluation } from "@/modules/experiments/experiment.objective";
import type { MetricComparison } from "@/modules/experiments/experiment.comparison";
import type {
  EvidenceAssessment,
  PairedSummary,
  SignTestResult,
} from "@/modules/experiments/experiment.statistics";
import {
  ConstraintChip,
  EvidenceChip,
  OutcomeBadge,
  formatMetricValue,
  metricLabel,
} from "./shared";

/**
 * The comparison page.
 *
 * One row per metric, one column per candidate, the baseline first — everything
 * computed by the comparison service from aligned per-case results, never from an
 * average of averages. Percentage differences are shown only where they mean
 * something (a zero baseline has no percentage change, and the cell says so).
 *
 * The regression table is the point of the page: cases that passed before and fail
 * now, cases that fail now and passed before, quality declines among passes, and
 * execution-path changes. Each finding links to the run that produced it.
 */

interface RegressionDto {
  kind: string;
  caseKey: string;
  name: string | null;
  isRegression: boolean;
  baseline: { score: number | null; passed: boolean | null; status: string; steps: number | null };
  candidate: { score: number | null; passed: boolean | null; status: string; steps: number | null };
  detail: string;
}

interface CandidateSideDto {
  metrics: CandidateMetrics;
  constraints: ConstraintEvaluation;
  primary: MetricComparison | null;
  secondary: MetricComparison[];
  regressions: RegressionDto[];
  pathChanges: RegressionDto[];
  notes: string[];
  rank: number | null;
  eligibleForWin: boolean;
  winBlockers: string[];
  reasons: string[];
  evidence: EvidenceAssessment | null;
  paired: PairedSummary | null;
  signTest: SignTestResult | null;
}

interface CaseSideDto {
  caseKey: string;
  index: number;
  name: string | null;
  tags: string[];
  baseline: CaseObservationDto | null;
  candidates: Array<{ candidateId: string; label: string; observation: CaseObservationDto | null }>;
}

interface CaseObservationDto {
  caseKey: string;
  meanScore: number | null;
  passed: boolean | null;
  scoredTrials: number;
  trials: Array<{
    replicate: number;
    evaluationBatchId: string;
    status: string;
    runId: string | null;
    aggregateScore: number | null;
    passed: boolean | null;
    durationMs: number | null;
    totalTokens: number | null;
    attempts: number;
    error: Record<string, unknown> | null;
  }>;
}

export interface ExperimentComparisonDto {
  experiment: {
    id: string;
    name: string;
    status: string;
    objective: { primary: { metric: string; direction: string }; secondary: Array<{ metric: string; direction: string }> };
    passThreshold: number | null;
    /** The compare endpoint returns the full experiment record; these two let the
     *  view offer promotion exactly once, from the comparison that justifies it. */
    selectedCandidateId: string | null;
    promotedCandidateId: string | null;
  };
  baselineCandidateId: string | null;
  baseline: { label: string; metrics: CandidateMetrics } | null;
  candidates: Array<{ id: string; label: string; role: string; harnessVersion: number; side: CandidateSideDto }>;
  ranking: {
    leader: { candidateId: string; label: string; statisticalSupport: boolean } | null;
    leaderNote: string;
    settled: boolean;
    notes: string[];
  };
  cases: CaseSideDto[];
  casesTruncated: boolean;
  /** Total aligned cases, so the per-case table can say when it is a window. */
  caseTotal: number;
}

/** The metrics shown as comparison rows, in a fixed reading order. */
const COMPARISON_ROWS: Array<{ key: string; label: string; read: (metrics: CandidateMetrics) => number | null }> = [
  { key: "evaluation_score", label: "Mean evaluation score", read: (m) => m.score.mean },
  { key: "pass_rate", label: "Pass rate", read: (m) => m.passRate },
  { key: "failure_rate", label: "Failure rate", read: (m) => m.failureRate },
  { key: "median_latency_ms", label: "Median latency", read: (m) => m.latency.medianMs },
  { key: "p95_latency_ms", label: "p95 latency", read: (m) => m.latency.p95Ms },
  { key: "average_total_tokens", label: "Average tokens per execution", read: (m) => (m.tokens.reported === 0 ? null : m.tokens.total / m.tokens.reported) },
  { key: "estimated_cost_usd", label: "Estimated cost per execution", read: (m) => (m.executions === 0 || m.cost.costUsd === null ? null : m.cost.costUsd / m.executions) },
  { key: "tool_calls_per_case", label: "Tool calls per case", read: (m) => m.toolCallsPerCase },
  { key: "timeout_rate", label: "Timeout rate", read: (m) => m.timeoutRate },
  { key: "retries", label: "Retries", read: (m) => m.retries },
];

/**
 * Difference and percentage change against the baseline.
 *
 * `percent` is a percentage (0…100), matching the comparison service's
 * `deltaPercent`, so a cell that shows "+50.0%" means exactly that. A zero or
 * missing baseline has no percentage, and the cell says so instead of showing
 * infinity.
 */
function movement(baseline: number | null, candidate: number | null, higherIsBetter: boolean) {
  if (baseline === null || candidate === null) {
    return { direction: "unknown" as const, delta: null, percent: null };
  }
  const delta = candidate - baseline;
  const percent = Math.abs(baseline) < 1e-12 ? null : (delta / Math.abs(baseline)) * 100;
  if (delta === 0) {
    return { direction: "unchanged" as const, delta, percent };
  }
  const improved = higherIsBetter ? delta > 0 : delta < 0;
  return { direction: improved ? ("improved" as const) : ("regressed" as const), delta, percent };
}

export function ExperimentComparisonView({
  experimentId,
  initial,
}: {
  experimentId: string;
  initial: ExperimentComparisonDto;
}) {
  const [regressionsOnly, setRegressionsOnly] = useState(false);
  const [includeCases, setIncludeCases] = useState(true);
  const [sortMetric, setSortMetric] = useState<string>("rank");
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(
    initial.candidates[0]?.id ?? null,
  );
  const [promoteOpen, setPromoteOpen] = useState(false);

  const query = useQuery({
    queryKey: ["experiment-comparison", experimentId, includeCases, regressionsOnly],
    queryFn: () =>
      api.get<ExperimentComparisonDto>(
        `/api/experiments/${experimentId}/compare?includeCases=${includeCases}${regressionsOnly ? "&regressionsOnly=true" : ""}`,
      ),
    initialData:
      includeCases && !regressionsOnly
        ? initial
        : undefined,
    refetchInterval: (data) =>
      data.state.data?.experiment.status === "RUNNING" || data.state.data?.experiment.status === "QUEUED"
        ? 6_000
        : false,
  });

  const data = query.data ?? initial;

  // Who the comparison would promote: the ranked leader when it is a
  // challenger, otherwise the first eligible challenger. The baseline never
  // needs promoting — it is what everything else is measured against.
  const promoteTarget =
    data.candidates.find(
      (candidate) =>
        candidate.id === data.ranking.leader?.candidateId &&
        candidate.id !== data.baselineCandidateId,
    ) ??
    data.candidates.find((candidate) => candidate.side.eligibleForWin) ??
    data.candidates[0];

  const sorted = useMemo(() => {
    const rows = [...data.candidates];
    if (sortMetric === "rank") {
      return rows.sort((a, b) => (a.side.rank ?? 99) - (b.side.rank ?? 99));
    }
    const row = COMPARISON_ROWS.find((entry) => entry.key === sortMetric);
    if (row === undefined) {
      return rows;
    }
    const higherIsBetter = data.experiment.objective.primary.metric === sortMetric
      ? data.experiment.objective.primary.direction === "maximize"
      : !["failure_rate", "median_latency_ms", "p95_latency_ms", "average_total_tokens", "estimated_cost_usd", "tool_calls_per_case", "timeout_rate", "retries"].includes(sortMetric);
    return rows.sort((a, b) => {
      const left = row.read(a.side.metrics);
      const right = row.read(b.side.metrics);
      if (left === null && right === null) return 0;
      if (left === null) return 1;
      if (right === null) return -1;
      return higherIsBetter ? right - left : left - right;
    });
  }, [data.candidates, sortMetric, data.experiment.objective.primary]);

  const primaryMetric = data.experiment.objective.primary.metric;
  const regressions = data.candidates.flatMap((candidate) =>
    candidate.side.regressions.map((finding) => ({ candidate, finding })),
  );
  const movements = data.candidates.flatMap((candidate) =>
    candidate.side.pathChanges.map((finding) => ({ candidate, finding })),
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span
            data-testid="experiment-settled"
            className={data.ranking.settled ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400"}
          >
            {data.ranking.settled
              ? "all planned executions settled"
              : "provisional — executions outstanding"}
          </span>
          {data.casesTruncated ? (
            <span>per-case view limited to the first 200 aligned cases</span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={regressionsOnly}
              onChange={(event) => setRegressionsOnly(event.target.checked)}
              className="h-3.5 w-3.5 rounded border"
              data-testid="experiment-regressions-only"
            />
            Only candidates with regressions
          </label>
          <label className="flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={includeCases}
              onChange={(event) => setIncludeCases(event.target.checked)}
              className="h-3.5 w-3.5 rounded border"
            />
            Per-case comparison
          </label>
          <select
            value={sortMetric}
            onChange={(event) => setSortMetric(event.target.value)}
            className="h-8 rounded-md border bg-transparent px-2 text-xs"
            data-testid="experiment-sort-metric"
          >
            <option value="rank">Sort by rank</option>
            {COMPARISON_ROWS.map((row) => (
              <option key={row.key} value={row.key}>
                Sort by {row.label}
              </option>
            ))}
          </select>
          <Button asChild size="sm" variant="outline" className="h-8 gap-1.5 text-xs">
            <a href={`/api/experiments/${experimentId}/export?format=json`}>
              <Download className="h-3.5 w-3.5" />
              JSON
            </a>
          </Button>
          <Button asChild size="sm" variant="outline" className="h-8 gap-1.5 text-xs">
            <a href={`/api/experiments/${experimentId}/export?format=csv`}>
              <Download className="h-3.5 w-3.5" />
              CSV
            </a>
          </Button>
        </div>
      </div>

      {query.isError ? <p className="text-xs text-destructive">{errorMessage(query.error)}</p> : null}

      <div className="flex flex-col gap-1.5 rounded-lg border bg-muted/20 p-3 text-xs">
        <p className="font-medium">
          {data.ranking.leader === null
            ? `No leading candidate — ${data.ranking.leaderNote}`
            : `Leading candidate: ${data.ranking.leader.label}${data.ranking.leader.statisticalSupport ? " (statistically supported)" : " (no statistical support claimed)"} — ${data.ranking.leaderNote}`}
        </p>
        {data.ranking.notes.length > 0 ? (
          <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[11px] text-muted-foreground">
            {data.ranking.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}
        {data.experiment.status !== "DRAFT" &&
        data.experiment.promotedCandidateId === null &&
        promoteTarget !== undefined ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={() => setPromoteOpen(true)}
              data-testid="experiment-compare-promote-open"
            >
              <Rocket className="h-3.5 w-3.5" />
              Promote {promoteTarget.label} (v{promoteTarget.harnessVersion})
            </Button>
            <span className="text-[11px] text-muted-foreground">
              Advances the agent&apos;s harness to this candidate&apos;s immutable version once it clears
              the pass-rate gate — published versions are never rewritten.
            </span>
          </div>
        ) : null}
        {data.experiment.promotedCandidateId !== null ? (
          <p className="mt-1.5 text-[11px] text-muted-foreground" data-testid="experiment-compare-promoted">
            Promoted:{" "}
            {data.experiment.promotedCandidateId === data.baselineCandidateId
              ? (data.baseline?.label ?? "baseline")
              : (data.candidates.find((entry) => entry.id === data.experiment.promotedCandidateId)
                  ?.label ?? "candidate")}{" "}
            — the harness now runs that version.
          </p>
        ) : null}
      </div>

      <div className="overflow-x-auto rounded-lg border" data-testid="experiment-comparison-table">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Metric</th>
              <th className="px-3 py-2 font-medium">
                Baseline{data.baseline === null ? "" : ` · ${data.baseline.label}`}
              </th>
              {sorted.map((candidate) => (
                <th key={candidate.id} className="px-3 py-2 font-medium">
                  <span className="flex flex-col gap-0.5">
                    <span className="text-foreground">{candidate.label}</span>
                    <span className="font-mono text-[10px] normal-case">
                      v{candidate.harnessVersion} · rank {candidate.side.rank ?? "—"}
                    </span>
                    <span
                      className={
                        candidate.side.eligibleForWin
                          ? "text-[10px] normal-case text-emerald-700 dark:text-emerald-400"
                          : "text-[10px] normal-case text-destructive"
                      }
                    >
                      {candidate.side.eligibleForWin ? "eligible" : "ineligible"}
                    </span>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {COMPARISON_ROWS.map((row) => {
              const baselineValue = data.baseline === null ? null : row.read(data.baseline.metrics);
              const higherIsBetter = row.key === primaryMetric
                ? data.experiment.objective.primary.direction === "maximize"
                : !["failure_rate", "median_latency_ms", "p95_latency_ms", "average_total_tokens", "estimated_cost_usd", "tool_calls_per_case", "timeout_rate", "retries"].includes(row.key);
              return (
                <tr key={row.key} className="border-b last:border-b-0">
                  <td className="px-3 py-2 text-xs">
                    <span className="font-medium">{row.label}</span>
                    <span className="ml-1 text-[10.5px] text-muted-foreground">
                      {higherIsBetter ? "↑ better" : "↓ better"}
                    </span>
                    {row.key === primaryMetric ? (
                      <span className="ml-1.5 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                        primary
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs tabular-nums">
                    {formatMetricValue(row.key, baselineValue)}
                  </td>
                  {sorted.map((candidate) => {
                    const value = row.read(candidate.side.metrics);
                    const move = movement(baselineValue, value, higherIsBetter);
                    return (
                      <td key={candidate.id} className="px-3 py-2 text-xs">
                        <span className="font-mono tabular-nums">
                          {formatMetricValue(row.key, value)}
                        </span>
                        <div className="mt-1">
                          <OutcomeBadge
                            direction={move.direction}
                            delta={move.delta}
                            deltaPercent={move.percent}
                            digits={row.key.includes("usd") ? 5 : row.key.includes("latency") ? 0 : 3}
                          />
                        </div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}

            <tr className="border-b">
              <td className="px-3 py-2 text-xs font-medium">Constraints</td>
              <td className="px-3 py-2 text-[11px] text-muted-foreground">—</td>
              {sorted.map((candidate) => (
                <td key={candidate.id} className="px-3 py-2">
                  {candidate.side.constraints.checks.length === 0 ? (
                    <span className="text-[11px] text-muted-foreground">none configured</span>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {candidate.side.constraints.checks.map((check: ConstraintCheck) => (
                        <ConstraintChip key={check.key} check={check} />
                      ))}
                    </div>
                  )}
                </td>
              ))}
            </tr>

            <tr className="border-b">
              <td className="px-3 py-2 text-xs font-medium">Evidence vs baseline</td>
              <td className="px-3 py-2 text-[11px] text-muted-foreground">baseline</td>
              {sorted.map((candidate) => (
                <td key={candidate.id} className="px-3 py-2 text-[11px]">
                  {candidate.side.evidence === null ? (
                    <span className="text-muted-foreground">not assessed</span>
                  ) : (
                    <div className="flex flex-col gap-1">
                      <EvidenceChip verdict={candidate.side.evidence.verdict} />
                      <span className="text-muted-foreground">{candidate.side.evidence.explanation}</span>
                      {candidate.side.paired !== null ? (
                        <span className="font-mono text-[10.5px] text-muted-foreground">
                          95% CI {candidate.side.paired.ciLow === null ? "—" : candidate.side.paired.ciLow.toFixed(3)} …{" "}
                          {candidate.side.paired.ciHigh === null ? "—" : candidate.side.paired.ciHigh.toFixed(3)} (n=
                          {candidate.side.paired.n})
                        </span>
                      ) : null}
                      {candidate.side.signTest !== null && candidate.side.signTest.pValue !== null ? (
                        <span className="font-mono text-[10.5px] text-muted-foreground">
                          sign test p={candidate.side.signTest.pValue.toFixed(4)} · +
                          {candidate.side.signTest.positive}/−{candidate.side.signTest.negative} ·{" "}
                          {candidate.side.signTest.ties} ties
                        </span>
                      ) : null}
                    </div>
                  )}
                </td>
              ))}
            </tr>

            <tr>
              <td className="px-3 py-2 text-xs font-medium">Ranking reason</td>
              <td className="px-3 py-2 text-[11px] text-muted-foreground">reference</td>
              {sorted.map((candidate) => (
                <td key={candidate.id} className="px-3 py-2 text-[11px]">
                  {candidate.side.reasons.length === 0 ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <ul className="flex list-disc flex-col gap-0.5 pl-4 text-muted-foreground">
                      {candidate.side.reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  )}
                  {candidate.side.notes.map((note) => (
                    <p key={note} className="mt-0.5 text-muted-foreground">
                      {note}
                    </p>
                  ))}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          Regressions ({regressions.length})
        </h2>
        <p className="text-[11px] text-muted-foreground">
          Cases where the baseline passed and the candidate failed, or where the candidate failed and
          the baseline passed. Each finding is derived from the stored per-case verdicts and links to
          the runs that produced them.
        </p>
        {regressions.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
            No case-level regressions were detected in the executed cases.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-left text-xs" data-testid="experiment-regressions">
              <thead className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Candidate</th>
                  <th className="px-3 py-2 font-medium">Case</th>
                  <th className="px-3 py-2 font-medium">Kind</th>
                  <th className="px-3 py-2 font-medium">Baseline</th>
                  <th className="px-3 py-2 font-medium">Candidate</th>
                  <th className="px-3 py-2 font-medium">Detail</th>
                  <th className="px-3 py-2 font-medium">Traces</th>
                </tr>
              </thead>
              <tbody>
                {regressions.map(({ candidate, finding }) => {
                  // Traces come from the per-case data already on the page: the
                  // candidate's trials for this case are the runs to read.
                  const traces =
                    data.cases
                      .find((entry) => entry.caseKey === finding.caseKey)
                      ?.candidates.find((side) => side.candidateId === candidate.id)?.observation
                      ?.trials ?? [];
                  return (
                    <tr key={`${candidate.id}-${finding.caseKey}-${finding.kind}`} className="border-b last:border-b-0">
                      <td className="px-3 py-2">{candidate.label}</td>
                      <td className="px-3 py-2">
                        <span className="font-mono">{finding.caseKey}</span>
                        {finding.name !== null ? (
                          <p className="text-[10.5px] text-muted-foreground">{finding.name}</p>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        {finding.isRegression ? (
                          <span className="inline-flex items-center gap-1 text-destructive">
                            <TrendingDown className="h-3 w-3" /> regression
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                            <TrendingUp className="h-3 w-3" /> improvement
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono">
                        {finding.baseline.score === null ? "—" : finding.baseline.score.toFixed(3)}
                        <span className="ml-1 text-[10.5px] text-muted-foreground">
                          {finding.baseline.passed === null ? "no verdict" : finding.baseline.passed ? "passed" : "failed"}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono">
                        {finding.candidate.score === null ? "—" : finding.candidate.score.toFixed(3)}
                        <span className="ml-1 text-[10.5px] text-muted-foreground">
                          {finding.candidate.passed === null ? "no verdict" : finding.candidate.passed ? "passed" : "failed"}
                        </span>
                      </td>
                      <td className="px-3 py-2 max-w-md text-muted-foreground">{finding.detail}</td>
                      <td className="px-3 py-2">
                        {traces.length === 0 ? (
                          <span className="text-muted-foreground">no run</span>
                        ) : (
                          <span className="flex flex-wrap gap-1.5">
                            {traces.map((trace) =>
                              trace.runId === null ? (
                                <Link
                                  key={`${trace.evaluationBatchId}-${trace.replicate}`}
                                  href={`/dashboard/evaluations/${trace.evaluationBatchId}`}
                                  className="underline hover:text-foreground"
                                >
                                  trial {trace.replicate} (no run)
                                </Link>
                              ) : (
                                <Link
                                  key={trace.runId}
                                  href={`/dashboard/runs/${trace.runId}`}
                                  className="underline hover:text-foreground"
                                >
                                  trial {trace.replicate}
                                </Link>
                              ),
                            )}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {movements.length > 0 ? (
          <div className="rounded-lg border p-3">
            <p className="text-xs font-medium">
              Execution-path changes ({movements.length}) — leads, not verdicts
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              The candidate executed a different number of nodes than the baseline on these cases. This
              is a signal worth reading in the trace, not a quality judgement.
            </p>
            <ul className="mt-1.5 flex flex-col gap-1 text-[11px]">
              {movements.slice(0, 20).map(({ candidate, finding }) => (
                <li key={`${candidate.id}-${finding.caseKey}-path`} className="flex flex-wrap gap-2">
                  <span className="font-medium">{candidate.label}</span>
                  <span className="font-mono">{finding.caseKey}</span>
                  <span className="text-muted-foreground">{finding.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {includeCases ? (
        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Per-case results</h2>
            <select
              value={selectedCandidateId ?? ""}
              onChange={(event) => setSelectedCandidateId(event.target.value)}
              className="h-8 rounded-md border bg-transparent px-2 text-xs"
              data-testid="experiment-case-candidate"
            >
              {data.candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.label}
                </option>
              ))}
            </select>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Aligned by stable dataset case key, never by position. A case with no result on either side
            shows &ldquo;not executed&rdquo; rather than a zero.
          </p>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-left text-xs" data-testid="experiment-cases-table">
              <thead className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Case</th>
                  <th className="px-3 py-2 font-medium">Tags</th>
                  <th className="px-3 py-2 font-medium">Baseline</th>
                  <th className="px-3 py-2 font-medium">Candidate</th>
                  <th className="px-3 py-2 font-medium">Movement</th>
                  <th className="px-3 py-2 font-medium">Runs</th>
                </tr>
              </thead>
              <tbody>
                {data.cases.map((entry) => {
                  const side = entry.candidates.find(
                    (candidate) => candidate.candidateId === selectedCandidateId,
                  );
                  const baselineScore = entry.baseline?.meanScore ?? null;
                  const candidateScore = side?.observation?.meanScore ?? null;
                  const move = movement(baselineScore, candidateScore, true);
                  return (
                    <tr key={entry.caseKey} className="border-b last:border-b-0">
                      <td className="px-3 py-2">
                        <span className="font-mono">{entry.caseKey}</span>
                        {entry.name !== null ? (
                          <p className="text-[10.5px] text-muted-foreground">{entry.name}</p>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-[10.5px] text-muted-foreground">
                        {entry.tags.length === 0 ? "—" : entry.tags.join(", ")}
                      </td>
                      <td className="px-3 py-2">
                        {entry.baseline === null ? (
                          <span className="text-muted-foreground">not executed</span>
                        ) : (
                          <span className="flex flex-col gap-0.5">
                            <ScoreBar value={baselineScore} />
                            <span className="text-[10.5px] text-muted-foreground">
                              {entry.baseline.passed === null ? "no verdict" : entry.baseline.passed ? "passed" : "failed"}
                              {entry.baseline.scoredTrials > 1 ? ` · ${entry.baseline.scoredTrials} trials` : ""}
                            </span>
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {side?.observation === undefined || side.observation === null ? (
                          <span className="text-muted-foreground">not executed</span>
                        ) : (
                          <span className="flex flex-col gap-0.5">
                            <ScoreBar value={candidateScore} />
                            <span className="text-[10.5px] text-muted-foreground">
                              {side.observation.passed === null
                                ? "no verdict"
                                : side.observation.passed
                                  ? "passed"
                                  : "failed"}
                              {side.observation.scoredTrials > 1
                                ? ` · ${side.observation.scoredTrials} trials`
                                : ""}
                            </span>
                            {side.observation.trials.some((trial) => trial.error !== null) ? (
                              <span className="text-[10.5px] text-destructive">
                                {side.observation.trials.filter((trial) => trial.error !== null).length} execution
                                failure(s)
                              </span>
                            ) : null}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <OutcomeBadge direction={move.direction} delta={move.delta} digits={3} />
                      </td>
                      <td className="px-3 py-2">
                        <span className="flex flex-wrap gap-1.5">
                          {entry.baseline?.trials.map((trial) =>
                            trial.runId === null ? null : (
                              <Link
                                key={`b-${trial.runId}`}
                                href={`/dashboard/runs/${trial.runId}`}
                                className="underline hover:text-foreground"
                              >
                                base
                              </Link>
                            ),
                          )}
                          {side?.observation?.trials.map((trial) =>
                            trial.runId === null ? null : (
                              <Link
                                key={`c-${trial.runId}`}
                                href={`/dashboard/runs/${trial.runId}`}
                                className="underline hover:text-foreground"
                              >
                                cand
                              </Link>
                            ),
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <ArrowRight className="h-3 w-3" />
        Every number on this page is calculated from persisted case executions. Cost figures are
        estimates derived from measured usage and the pinned price list — Orqestra has no billing
        integration and never reports a billed amount.
        {data.experiment.passThreshold === null
          ? ""
          : ` A case passes at a weighted aggregate of ${data.experiment.passThreshold} or more.`}
      </p>
      <p className="sr-only">
        {metricLabel(primaryMetric)} is the primary metric for this experiment.
      </p>

      {promoteOpen && promoteTarget !== undefined ? (
        <PromoteFromComparisonDialog
          experimentId={experimentId}
          candidates={data.candidates}
          preferredId={promoteTarget.id}
          passThreshold={data.experiment.passThreshold}
          settled={data.ranking.settled}
          onClose={() => setPromoteOpen(false)}
          onDone={() => setPromoteOpen(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * Promoting straight from the comparison: the winner's immutable version
 * becomes the harness's current version, gated on a pass rate the reviewer can
 * read next to the candidate's observed rate. The server re-checks every gate
 * (settled experiment, constraints, sealed batch, pass-rate threshold) — this
 * dialog exists to make the question legible, not to authorize it.
 */
function PromoteFromComparisonDialog({
  experimentId,
  candidates,
  preferredId,
  passThreshold,
  settled,
  onClose,
  onDone,
}: {
  experimentId: string;
  candidates: ExperimentComparisonDto["candidates"];
  preferredId: string;
  passThreshold: number | null;
  settled: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [candidateId, setCandidateId] = useState(preferredId);
  const [threshold, setThreshold] = useState("");
  const [notes, setNotes] = useState("");
  const queryClient = useQueryClient();

  const promote = useMutation({
    mutationFn: () =>
      api.post<{ harnessVersion: { version: number }; promotedFrom: number; warnings: string[] }>(
        `/api/experiments/${experimentId}/promote`,
        {
          candidateId,
          ...(threshold.trim() === "" ? {} : { passRateThreshold: Number(threshold) }),
          ...(notes.trim() === "" ? {} : { notes: notes.trim() }),
        },
      ),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["experiment-comparison", experimentId] });
      void queryClient.invalidateQueries({ queryKey: ["experiment-metrics", experimentId] });
      if (result.warnings.length === 0) {
        onDone();
        return;
      }
      // Warnings belong on screen with the decision: keep the dialog open and
      // record them where the reviewer can copy them into the experiment.
      setNotes((current) =>
        [
          current,
          "Warnings recorded with this promotion:",
          ...result.warnings.map((warning) => `- ${warning}`),
        ]
          .filter((entry) => entry.trim() !== "")
          .join("\n"),
      );
    },
  });

  const target = candidates.find((candidate) => candidate.id === candidateId);
  const thresholdValue = threshold.trim() === "" ? (passThreshold ?? 0.75) : Number(threshold);
  const passRate = target?.side.metrics.passRate ?? null;
  const clearsGate = passRate !== null && passRate >= thresholdValue;
  const regressionCount = target?.side.regressions.length ?? 0;

  return (
    <Dialog open onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Promote the winning version</DialogTitle>
          <DialogDescription>
            The harness advances to this candidate&apos;s immutable version once it clears the pass-rate
            gate. Promotion is forward-only: no published version is rewritten, and the baseline and
            every other candidate stay exactly as they ran.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="compare-promote-candidate">Winning candidate</Label>
            <select
              id="compare-promote-candidate"
              value={candidateId}
              onChange={(event) => setCandidateId(event.target.value)}
              className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
              data-testid="experiment-compare-promote-candidate"
            >
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.label} (v{candidate.harnessVersion}, rank {candidate.side.rank ?? "—"})
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="compare-promote-threshold">Minimum pass rate for promotion (0–1)</Label>
            <Input
              id="compare-promote-threshold"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={threshold}
              onChange={(event) => setThreshold(event.target.value)}
              placeholder={
                passThreshold === null ? "0.75 (server default)" : `${passThreshold} (experiment threshold)`
              }
              data-testid="experiment-compare-promote-threshold"
            />
            {passRate === null ? (
              <p className="text-[11px] text-muted-foreground">
                No pass verdict for this candidate — the server refuses to promote without one.
              </p>
            ) : (
              <p
                className={`text-[11px] ${
                  clearsGate ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"
                }`}
                data-testid="experiment-compare-promote-gate"
              >
                {target?.label ?? "Candidate"} passed {Math.round(passRate * 100)}% of cases —{" "}
                {clearsGate
                  ? `clears the ${thresholdValue} gate.`
                  : `below the ${thresholdValue} gate; the server will refuse this promotion.`}
              </p>
            )}
          </div>

          {!settled ? (
            <p
              className="rounded-md border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300"
              data-testid="experiment-compare-promote-unsettled"
            >
              Evidence is still provisional — executions are outstanding, so promotion stays blocked
              until the experiment settles.
            </p>
          ) : null}
          {regressionCount > 0 ? (
            <p className="text-[11px] text-amber-700 dark:text-amber-400">
              {regressionCount} case-level regression(s) against the baseline are recorded with this
              candidate.
            </p>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="compare-promote-notes">Notes (optional)</Label>
            <Textarea
              id="compare-promote-notes"
              rows={3}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Cleared the pass-rate gate on every verified case."
            />
          </div>

          {promote.isError ? (
            <p className="text-xs text-destructive">{errorMessageWithIssues(promote.error)}</p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button
            onClick={() => promote.mutate()}
            disabled={promote.isPending || candidateId === ""}
            data-testid="experiment-compare-promote-submit"
          >
            {promote.isPending ? "Promoting…" : `Promote v${target?.harnessVersion ?? ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
