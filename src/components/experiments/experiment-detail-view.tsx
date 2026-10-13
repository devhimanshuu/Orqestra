"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, GitCompare, Info, Pause, Play, ShieldCheck, Square } from "lucide-react";
import { api, errorMessageWithIssues } from "@/lib/api/client";
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
import { formatCost, formatDuration, formatRelativeTime } from "@/components/run-status";
import { ScoreBar } from "@/components/evaluation/shared";
import type { CandidateMetrics, ExperimentMetrics } from "@/modules/experiments/experiment.metrics";
import type {
  ExperimentCandidateSummary,
  ExperimentObjective,
  ExperimentProgress,
  ExperimentStatus,
} from "@/modules/experiments/experiment.types";
import type { ExperimentRanking } from "@/modules/experiments/experiment.ranking";
import type { ConstraintCheck } from "@/modules/experiments/experiment.objective";
import {
  ConstraintChip,
  ExperimentStatusChip,
  MetricCell,
  ProgressBar,
  metricLabel,
} from "./shared";

/**
 * The experiment dashboard.
 *
 * Everything numeric comes from persisted experiment data (the case rows their
 * sealed batches own). While the experiment is active the view polls progress and
 * metrics; once it settles it stops.
 *
 * Two deliberate omissions:
 *
 *  - **No winner before the evidence supports one.** The leader row renders the
 *    ranking's own note, so an in-flight experiment shows "provisional — N
 *    executions outstanding" instead of a confident name.
 *  - **No promotion button until a candidate is selected.** Selection is an
 *    attributed human decision; promotion is a separate, confirmed act.
 */

export interface ConstraintStatusDto {
  candidateId: string;
  violated: number;
  satisfied: number;
  unknown: number;
  checks: ConstraintCheck[];
}

export interface ExperimentDetailDto {
  experiment: {
    id: string;
    name: string;
    description: string | null;
    hypothesis: string | null;
    status: ExperimentStatus;
    passThreshold: number | null;
    scoringPolicy: string;
    caseCount: number;
    plannedRunCount: number;
    objective: ExperimentObjective;
    startedAt: string | null;
    completedAt: string | null;
    pausedAt: string | null;
    cancelRequestedAt: string | null;
    selectedCandidateId: string | null;
    selectionKind: "RECOMMENDED" | "SELECTED" | null;
    selectionNotes: string | null;
    promotedCandidateId: string | null;
    promotionNotes: string | null;
    reproducibilityNotes: string[];
    engineVersion: string;
    pricingVersion: string;
    harnessVersions: Array<{ label: string; role: string; harnessVersionId: string; harnessVersion: number }>;
  };
  progress: ExperimentProgress;
  agent: { id: string; name: string } | null;
  dataset: { id: string; name: string; version: number } | null;
  candidates: ExperimentCandidateSummary[];
  evaluators: Array<{ key: string; name: string; kind: string; version: number; weight: number }>;
  metrics: ExperimentMetrics | null;
  ranking: ExperimentRanking;
  constraintStatus: ConstraintStatusDto[];
}

interface MetricsResponse {
  metrics: CandidateMetrics[];
  ranking: ExperimentRanking;
  constraintStatus: ConstraintStatusDto[];
  progress: ExperimentProgress;
}

function isActive(status: string): boolean {
  return status === "QUEUED" || status === "RUNNING" || status === "PAUSED";
}

export function ExperimentDetailView({ initial }: { initial: ExperimentDetailDto }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [selectOpen, setSelectOpen] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const experimentId = initial.experiment.id;

  const metricsQuery = useQuery({
    queryKey: ["experiment-metrics", experimentId],
    queryFn: () =>
      api.get<MetricsResponse>(`/api/experiments/${experimentId}/metrics?withAnalysis=false`),
    refetchInterval: (query) =>
      isActive(query.state.data?.progress.status ?? initial.experiment.status) ? 5_000 : false,
  });

  const live = metricsQuery.data;
  const progress = live?.progress ?? initial.progress;
  const status = progress.status;
  const metrics = live?.metrics ?? initial.metrics?.candidates ?? [];
  const ranking = live?.ranking ?? initial.ranking;
  const constraints = live?.constraintStatus ?? initial.constraintStatus;

  const candidatesById = new Map(initial.candidates.map((candidate) => [candidate.id, candidate]));
  const constraintsById = new Map(constraints.map((entry) => [entry.candidateId, entry]));

  /** Lifecycle actions all end the same way: re-read the authoritative state. */
  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["experiment-metrics", experimentId] }),
      queryClient.invalidateQueries({ queryKey: ["experiments"] }),
    ]);
    router.refresh();
  };

  const launch = useMutation({
    mutationFn: () => api.post(`/api/experiments/${experimentId}/launch`, { confirm: true }),
    onSuccess: () => void refresh(),
  });
  const cancel = useMutation({
    mutationFn: () => api.post(`/api/experiments/${experimentId}/cancel`),
    onSuccess: () => void refresh(),
  });
  const pause = useMutation({
    mutationFn: () => api.post(`/api/experiments/${experimentId}/pause`),
    onSuccess: () => void refresh(),
  });
  const resume = useMutation({
    mutationFn: () => api.post(`/api/experiments/${experimentId}/resume`),
    onSuccess: () => void refresh(),
  });

  const mutationError = launch.error ?? cancel.error ?? pause.error ?? resume.error;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">{initial.experiment.name}</h1>
              <ExperimentStatusChip value={status} />
              {status === "DRAFT" ? (
                <span className="text-[11px] text-muted-foreground">
                  draft — nothing has executed yet
                </span>
              ) : null}
            </div>
            {initial.experiment.hypothesis !== null ? (
              <p className="max-w-3xl text-xs text-muted-foreground">{initial.experiment.hypothesis}</p>
            ) : null}
            {initial.experiment.description !== null ? (
              <p className="max-w-3xl text-xs text-muted-foreground">{initial.experiment.description}</p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {status === "DRAFT" ? (
              <Button
                size="sm"
                className="h-8 gap-1.5 text-xs"
                onClick={() => launch.mutate()}
                disabled={launch.isPending}
                data-testid="experiment-launch"
              >
                <Play className="h-3.5 w-3.5" />
                {launch.isPending ? "Launching…" : "Launch"}
              </Button>
            ) : null}
            {status === "QUEUED" || status === "RUNNING" ? (
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 text-xs"
                onClick={() => pause.mutate()}
                disabled={pause.isPending}
                data-testid="experiment-pause"
              >
                <Pause className="h-3.5 w-3.5" />
                Pause
              </Button>
            ) : null}
            {status === "PAUSED" ? (
              <Button
                size="sm"
                className="h-8 gap-1.5 text-xs"
                onClick={() => resume.mutate()}
                disabled={resume.isPending}
                data-testid="experiment-resume"
              >
                <Play className="h-3.5 w-3.5" />
                Resume
              </Button>
            ) : null}
            {status === "DRAFT" || status === "QUEUED" || status === "RUNNING" || status === "PAUSED" ? (
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 text-xs"
                onClick={() => cancel.mutate()}
                disabled={cancel.isPending}
                data-testid="experiment-cancel"
              >
                <Square className="h-3.5 w-3.5" />
                Cancel
              </Button>
            ) : null}
            <Button asChild size="sm" variant="outline" className="h-8 gap-1.5 text-xs">
              <Link href={`/dashboard/experiments/${experimentId}/compare`} data-testid="experiment-compare-link">
                <GitCompare className="h-3.5 w-3.5" />
                Compare
              </Link>
            </Button>
            <Button asChild size="sm" variant="outline" className="h-8 gap-1.5 text-xs">
              <a href={`/api/experiments/${experimentId}/export?format=json`} data-testid="experiment-export">
                <Download className="h-3.5 w-3.5" />
                Export
              </a>
            </Button>
          </div>
        </div>

        {mutationError !== null && mutationError !== undefined ? (
          <p className="text-xs text-destructive">{errorMessageWithIssues(mutationError)}</p>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCell
            label="Progress"
            value={`${progress.completed + progress.failed + progress.cancelled}/${progress.plannedExecutions}`}
            hint={`${progress.running} running · ${progress.pending} pending`}
          />
          <MetricCell
            label="Failures"
            value={String(progress.failed)}
            hint="executions that failed — excluded from score aggregates"
          />
          <MetricCell
            label="Dataset"
            value={initial.dataset === null ? "—" : `${initial.dataset.name} v${initial.dataset.version}`}
            hint={`${initial.experiment.caseCount} case${initial.experiment.caseCount === 1 ? "" : "s"}`}
          />
          <MetricCell
            label="Agent"
            value={initial.agent?.name ?? "—"}
            hint={initial.experiment.startedAt === null ? "not started" : `started ${formatRelativeTime(initial.experiment.startedAt)}`}
          />
        </div>

        <div className="flex flex-col gap-2">
          <ProgressBar percent={progress.percent} label={`${Math.round(progress.percent * 100)}% settled`} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            <span>
              Objective:{" "}
              <span className="font-medium text-foreground">
                {metricLabel(initial.experiment.objective.primary.metric)}
              </span>{" "}
              ({initial.experiment.objective.primary.direction})
            </span>
            <span>
              Replicates:{" "}
              <span className="font-mono text-foreground">{initial.candidates[0]?.batchStatuses.length ?? 1}</span>
            </span>
            <span>
              Scoring: <span className="text-foreground">{initial.experiment.scoringPolicy}</span>
              {initial.experiment.passThreshold === null
                ? ""
                : ` · pass ≥ ${initial.experiment.passThreshold}`}
            </span>
            {initial.experiment.pausedAt !== null ? (
              <span className="text-amber-700 dark:text-amber-400">
                paused {formatRelativeTime(initial.experiment.pausedAt)}
              </span>
            ) : null}
            {initial.experiment.cancelRequestedAt !== null ? (
              <span className="text-destructive">
                cancellation requested {formatRelativeTime(initial.experiment.cancelRequestedAt)}
              </span>
            ) : null}
          </div>
        </div>
      </header>

      <section className="flex flex-col gap-3 rounded-lg border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Candidate comparison</h2>
          <span className="text-[11px] text-muted-foreground">
            {ranking.settled
              ? "every planned execution has settled"
              : "provisional — executions are still outstanding"}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm" data-testid="experiment-candidates-table">
            <thead className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Candidate</th>
                <th className="px-3 py-2 font-medium">Harness</th>
                <th className="px-3 py-2 font-medium">Executions</th>
                <th className="px-3 py-2 font-medium">Mean score</th>
                <th className="px-3 py-2 font-medium">Pass rate</th>
                <th className="px-3 py-2 font-medium">Failure rate</th>
                <th className="px-3 py-2 font-medium">Median latency</th>
                <th className="px-3 py-2 font-medium">Tokens</th>
                <th className="px-3 py-2 font-medium">Est. cost</th>
                <th className="px-3 py-2 font-medium">Tool calls / case</th>
                <th className="px-3 py-2 font-medium">Constraints</th>
                <th className="px-3 py-2 font-medium">Rank</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((entry) => {
                const candidate = candidatesById.get(entry.candidateId);
                const constraint = constraintsById.get(entry.candidateId);
                const ranked = ranking.candidates.find(
                  (item) => item.metrics.candidateId === entry.candidateId,
                );
                return (
                  <tr key={entry.candidateId} className="border-b last:border-b-0">
                    <td className="px-3 py-2.5">
                      <span className="font-medium">{entry.label}</span>
                      <span className="ml-1.5 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                        {entry.role.toLowerCase()}
                      </span>
                      {candidate !== undefined ? (
                        <p className="mt-1 text-[10.5px] text-muted-foreground">
                          {candidate.batchStatuses.map((batch) => (
                            <Link
                              key={batch.batchId}
                              href={`/dashboard/evaluations/${batch.batchId}`}
                              className="mr-2 underline hover:text-foreground"
                            >
                              trial {batch.replicate}: {batch.status.replace(/_/g, " ").toLowerCase()}
                            </Link>
                          ))}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs">
                      {candidate?.harnessName ?? "—"} v{entry.harnessVersion}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs">
                      {entry.completed + entry.failed + entry.cancelled}/{entry.plannedExecutions}
                      {entry.running + entry.pending > 0 ? (
                        <span className="ml-1 text-muted-foreground">
                          ({entry.running} running, {entry.pending} pending)
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5">
                      <ScoreBar value={entry.score.mean} />
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs">
                      {entry.passRate === null ? "—" : `${Math.round(entry.passRate * 100)}%`}
                      <span className="ml-1 text-[10.5px] text-muted-foreground">
                        {entry.passed}/{entry.passed + entry.failedVerdicts}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs">
                      {entry.failureRate === null ? "—" : `${Math.round(entry.failureRate * 100)}%`}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs">
                      {entry.latency.medianMs === null ? "—" : formatDuration(entry.latency.medianMs)}
                      {entry.latency.p95Ms === null ? null : (
                        <span className="ml-1 text-[10.5px] text-muted-foreground">
                          p95 {formatDuration(entry.latency.p95Ms)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs">
                      {entry.tokens.reported === 0 ? "not reported" : entry.tokens.total}
                      {entry.tokens.unreported > 0 ? (
                        <span className="ml-1 text-[10.5px] text-muted-foreground">
                          {entry.tokens.unreported} unreported
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs" title="estimate, never a billed amount">
                      {formatCost(entry.cost.costUsd, entry.cost.costUsd === null)}
                      {entry.cost.unpriced.length > 0 ? (
                        <p className="text-[10.5px] text-muted-foreground">
                          unpriced: {entry.cost.unpriced.join(", ")}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs">
                      {entry.toolCallsPerCase === null ? "—" : entry.toolCallsPerCase.toFixed(2)}
                      {entry.timedOut > 0 ? (
                        <p className="text-[10.5px] text-destructive">{entry.timedOut} timed out</p>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5">
                      {constraint === undefined || constraint.checks.length === 0 ? (
                        <span className="text-[11px] text-muted-foreground">none configured</span>
                      ) : (
                        <div className="flex flex-col gap-1">
                          {constraint.checks.map((check) => (
                            <ConstraintChip key={check.key} check={check} />
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      {ranked?.rank === null || ranked === undefined ? (
                        <span className="text-muted-foreground">not ranked</span>
                      ) : (
                        <span className="font-medium">#{ranked.rank}</span>
                      )}
                      {ranked !== undefined && ranked.winBlockers.length > 0 ? (
                        <p className="mt-0.5 max-w-[16rem] text-[10.5px] text-destructive">
                          {ranked.winBlockers[0]}
                        </p>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col gap-1.5 rounded-md border bg-muted/20 p-3">
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <Info className="h-3.5 w-3.5" />
            {ranking.leader === null
              ? `No leading candidate yet — ${ranking.leaderNote}`
              : `Leading candidate: ${ranking.leader.label}${ranking.leader.statisticalSupport ? " (statistically supported)" : ""} — ${ranking.leaderNote}`}
          </p>
          {ranking.notes.length > 0 ? (
            <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[11px] text-muted-foreground">
              {ranking.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
        </div>

        {status !== "DRAFT" ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 text-xs"
              onClick={() => setSelectOpen(true)}
              data-testid="experiment-select-open"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              Select a candidate
            </Button>
            {initial.experiment.selectedCandidateId !== null ? (
              <Button
                size="sm"
                className="h-8 gap-1.5 text-xs"
                onClick={() => setPromoteOpen(true)}
                data-testid="experiment-promote-open"
              >
                Promote selected version
              </Button>
            ) : null}
            {initial.experiment.selectedCandidateId !== null ? (
              <span className="text-[11px] text-muted-foreground">
                selected: {candidatesById.get(initial.experiment.selectedCandidateId)?.label ?? "—"}
                {initial.experiment.selectionKind === null ? "" : ` (${initial.experiment.selectionKind.toLowerCase()})`}
              </span>
            ) : null}
            {initial.experiment.promotedCandidateId !== null ? (
              <span className="text-[11px] text-muted-foreground">
                promoted: {candidatesById.get(initial.experiment.promotedCandidateId)?.label ?? "—"}
              </span>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
          <h2 className="text-sm font-semibold">Sealed configuration</h2>
          <p className="text-[11px] text-muted-foreground">
            Written once at launch. These pins are what every result in this experiment traces back to.
          </p>
          <ul className="flex flex-col gap-1 text-[11px]">
            {initial.experiment.harnessVersions.map((entry) => (
              <li key={`${entry.label}-${entry.harnessVersionId}`} className="flex items-center gap-2">
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                  {entry.role.toLowerCase()}
                </span>
                <span className="font-medium">{entry.label}</span>
                <span className="font-mono text-muted-foreground">v{entry.harnessVersion}</span>
                <span className="font-mono text-[10.5px] text-muted-foreground">
                  {entry.harnessVersionId.slice(-8)}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-1 flex flex-col gap-1 text-[11px]">
            <span className="font-medium">Evaluators</span>
            <ul className="flex flex-col gap-0.5 text-muted-foreground">
              {initial.evaluators.map((evaluator) => (
                <li key={`${evaluator.key}-${evaluator.version}`} className="font-mono">
                  {evaluator.name} · {evaluator.kind} · v{evaluator.version} · weight {evaluator.weight}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
          <h2 className="text-sm font-semibold">Reproducibility</h2>
          <p className="text-[11px] text-muted-foreground">
            Engine <span className="font-mono text-foreground">{initial.experiment.engineVersion}</span> ·
            pricing <span className="font-mono text-foreground">{initial.experiment.pricingVersion}</span>
          </p>
          {initial.experiment.reproducibilityNotes.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              No caveats were recorded for this experiment.
            </p>
          ) : (
            <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[11px] text-muted-foreground">
              {initial.experiment.reproducibilityNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
          {initial.experiment.promotionNotes !== null ? (
            <div className="mt-1 rounded-md border bg-muted/20 p-2 text-[11px]">
              <p className="font-medium">Promotion record</p>
              <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">
                {initial.experiment.promotionNotes}
              </p>
            </div>
          ) : null}
          {initial.experiment.selectionNotes !== null ? (
            <div className="mt-1 rounded-md border bg-muted/20 p-2 text-[11px]">
              <p className="font-medium">Selection note</p>
              <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">
                {initial.experiment.selectionNotes}
              </p>
            </div>
          ) : null}
        </div>
      </section>

      {selectOpen ? (
        <SelectCandidateDialog
          experimentId={experimentId}
          candidates={initial.candidates}
          onClose={() => setSelectOpen(false)}
          onDone={() => {
            setSelectOpen(false);
            void refresh();
          }}
        />
      ) : null}

      {promoteOpen ? (
        <PromoteCandidateDialog
          experimentId={experimentId}
          candidates={initial.candidates}
          selectedCandidateId={initial.experiment.selectedCandidateId}
          onClose={() => setPromoteOpen(false)}
          onDone={() => {
            setPromoteOpen(false);
            void refresh();
          }}
        />
      ) : null}

      {status === "DRAFT" ? (
        <p className="text-[11px] text-muted-foreground">
          This is a draft. Launching seals the configuration and starts executing every planned case
          through the ordinary runtime; the request that launches it executes nothing itself.
        </p>
      ) : null}
    </div>
  );
}

/** Selection records a decision and shows every warning the server raised with it. */
function SelectCandidateDialog({
  experimentId,
  candidates,
  onClose,
  onDone,
}: {
  experimentId: string;
  candidates: ExperimentCandidateSummary[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [candidateId, setCandidateId] = useState(candidates[0]?.id ?? "");
  const [kind, setKind] = useState<"SELECTED" | "RECOMMENDED">("SELECTED");
  const [notes, setNotes] = useState("");

  const select = useMutation({
    mutationFn: () =>
      api.post<{ warnings: string[]; authorization: { blockers: string[] } }>(
        `/api/experiments/${experimentId}/select`,
        { candidateId, kind, ...(notes.trim() === "" ? {} : { notes: notes.trim() }) },
      ),
    onSuccess: (result) => {
      if (result.warnings.length === 0 && result.authorization.blockers.length === 0) {
        onDone();
        return;
      }
      // Warnings are for the author to read, not for the service to hide: keep the
      // dialog open so the decision is made with them on screen.
      setNotes((current) =>
        [
          current,
          "Warnings recorded with this decision:",
          ...result.authorization.blockers.map((entry) => `- blocked: ${entry}`),
          ...result.warnings.map((entry) => `- ${entry}`),
        ]
          .filter((entry) => entry.trim() !== "")
          .join("\n"),
      );
    },
  });

  return (
    <Dialog open onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Select a candidate</DialogTitle>
          <DialogDescription>
            This records your decision on the experiment — it does not change any harness version.
            Promotion is a separate, confirmed step.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="select-candidate">Candidate</Label>
            <select
              id="select-candidate"
              value={candidateId}
              onChange={(event) => setCandidateId(event.target.value)}
              className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
              data-testid="experiment-select-candidate"
            >
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.label} ({candidate.role.toLowerCase()}, v{candidate.harnessVersion})
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="select-kind">Decision</Label>
            <select
              id="select-kind"
              value={kind}
              onChange={(event) => setKind(event.target.value === "RECOMMENDED" ? "RECOMMENDED" : "SELECTED")}
              className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
            >
              <option value="SELECTED">Selected — this is the candidate to promote</option>
              <option value="RECOMMENDED">Recommended — worth promoting, not decided yet</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="select-notes">Notes (optional)</Label>
            <Textarea
              id="select-notes"
              rows={3}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Correctness improved on hard cases; cost unchanged."
            />
          </div>
          {select.isError ? (
            <p className="text-xs text-destructive">{errorMessageWithIssues(select.error)}</p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => select.mutate()}
            disabled={select.isPending || candidateId === ""}
            data-testid="experiment-select-submit"
          >
            {select.isPending ? "Recording…" : "Record decision"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PromoteCandidateDialog({
  experimentId,
  candidates,
  selectedCandidateId,
  onClose,
  onDone,
}: {
  experimentId: string;
  candidates: ExperimentCandidateSummary[];
  selectedCandidateId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [candidateId, setCandidateId] = useState(selectedCandidateId ?? candidates[0]?.id ?? "");
  const [threshold, setThreshold] = useState("");
  const [notes, setNotes] = useState("");

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
    onSuccess: () => onDone(),
  });

  const target = candidates.find((candidate) => candidate.id === candidateId);

  return (
    <Dialog open onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Promote the selected candidate</DialogTitle>
          <DialogDescription>
            The harness advances to this candidate&apos;s immutable version. Promotion is forward-only:
            a published version is never rewritten, and the baseline and every other candidate stay
            exactly as they ran.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="promote-candidate">Candidate</Label>
            <select
              id="promote-candidate"
              value={candidateId}
              onChange={(event) => setCandidateId(event.target.value)}
              className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
              data-testid="experiment-promote-candidate"
            >
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.label} ({candidate.role.toLowerCase()}, v{candidate.harnessVersion})
                </option>
              ))}
            </select>
          </div>
          {target !== undefined ? (
            <p className="rounded-md border bg-muted/20 p-2 text-[11px] text-muted-foreground">
              {target.harnessName} v{target.harnessVersion} · content hash{" "}
              <span className="font-mono">{target.contentHash.slice(0, 16)}…</span>
            </p>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="promote-threshold">Minimum pass rate for promotion (0–1)</Label>
            <Input
              id="promote-threshold"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={threshold}
              onChange={(event) => setThreshold(event.target.value)}
              placeholder="Harness default"
            />
            <p className="text-[11px] text-muted-foreground">
              The harness service refuses a promotion whose winning batch is below this pass rate.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="promote-notes">Why this candidate (recorded)</Label>
            <Textarea
              id="promote-notes"
              rows={3}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Statistically supported improvement on the hard cases, no cost regression."
            />
          </div>
          {promote.isError ? (
            <p className="text-xs text-destructive">{errorMessageWithIssues(promote.error)}</p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => promote.mutate()}
            disabled={promote.isPending || candidateId === ""}
            data-testid="experiment-promote-submit"
          >
            {promote.isPending ? "Promoting…" : "Promote version"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
