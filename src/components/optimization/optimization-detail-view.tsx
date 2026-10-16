"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Download,
  FileText,
  GitBranch,
  Hand,
  Play,
  RefreshCw,
  ShieldCheck,
  Square,
  XCircle,
} from "lucide-react";
import { api, errorMessage } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatRelativeTime } from "@/components/run-status";
import type { OptimizationDetail } from "@/modules/optimization/optimization.service";
import {
  Budget,
  DecisionChip,
  LoopPrinciple,
  MetricValue,
  OptimizationStatusChip,
  StopReasonNote,
} from "./shared";

/**
 * Dates cross the server boundary as ISO strings; everything else arrives as it
 * was persisted. One recursive type describes that, so the view reads the same
 * shape the service returns.
 */
type JsonDates<T> = T extends Date
  ? string
  : T extends Array<infer U>
    ? Array<JsonDates<U>>
    : T extends object
      ? { [K in keyof T]: JsonDates<T[K]> }
      : T;

export type OptimizationDetailJson = JsonDates<OptimizationDetail>;

interface ActionState {
  busy: string | null;
  error: string | null;
}

function isActive(status: string): boolean {
  return status === "QUEUED" || status === "RUNNING" || status === "WAITING_FOR_REVIEW";
}

/**
 * The optimization inspector.
 *
 * The whole loop is visible on one screen: the evidence it started from, the
 * findings it proved (each linked to the cases and runs that show it), the
 * hypotheses, every candidate with its typed changes and its measured verdict,
 * the timeline, and the report. Actions are gated by status, and every one of
 * them is an explicit, attributed call — nothing here runs by itself.
 */
export function OptimizationDetailView({
  initial,
}: {
  initial: OptimizationDetailJson;
}) {
  const queryClient = useQueryClient();
  const [action, setAction] = useState<ActionState>({ busy: null, error: null });
  const [manualOpen, setManualOpen] = useState(false);

  const query = useQuery({
    queryKey: ["optimization", initial.session.id],
    queryFn: () =>
      api.get<OptimizationDetailJson>(`/api/optimizations/${initial.session.id}`),
    initialData: initial,
    refetchInterval: (data) => (isActive(data.state.data?.session.status ?? "") ? 4_000 : false),
  });

  const detail = query.data ?? initial;
  const { session, progress, ranking, review } = detail;
  const settled = !isActive(session.status);

  async function run(key: string, request: () => Promise<unknown>): Promise<void> {
    setAction({ busy: key, error: null });
    try {
      await request();
      await queryClient.invalidateQueries({ queryKey: ["optimization", session.id] });
      await queryClient.invalidateQueries({ queryKey: ["optimizations"] });
    } catch (error) {
      setAction({ busy: null, error: errorMessage(error) });
      return;
    }
    setAction({ busy: null, error: null });
  }

  const pendingCandidate = detail.candidates.find(
    (candidate) =>
      candidate.status === "PROPOSED" &&
      candidate.evaluationBatchId === null &&
      candidate.pendingDefinition !== null,
  );

  return (
    <div className="flex flex-col gap-5" data-testid="optimization-detail">
      {/* --- header ----------------------------------------------------------- */}
      <section className="flex flex-col gap-3 rounded-lg border p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold tracking-tight">{session.name}</h2>
              <OptimizationStatusChip value={session.status} />
              {session.promotedCandidateId !== null ? (
                <span className="flex items-center gap-1 rounded border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 text-[10.5px] font-medium text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="h-3 w-3" /> promoted
                </span>
              ) : null}
            </div>
            {session.description !== null ? (
              <p className="mt-1 text-sm text-muted-foreground">{session.description}</p>
            ) : null}
            <p className="mt-1 text-xs text-muted-foreground">
              {detail.agent?.name ?? "Agent"} · {detail.harness?.name ?? "Harness"} baseline{" "}
              {detail.baseline === null ? "—" : `v${detail.baseline.version}`} ·{" "}
              {detail.sourceBatch?.caseCount ?? 0} case evidence batch
            </p>
            <LoopPrinciple />
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {!settled ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1 text-xs"
                  disabled={action.busy !== null || session.status === "RUNNING"}
                  onClick={() =>
                    void run("start", () =>
                      api.post(`/api/optimizations/${session.id}/start`, { confirm: true }),
                    )
                  }
                  data-testid="optimization-start"
                >
                  <Play className="h-3.5 w-3.5" />
                  {session.status === "DRAFT" ? "Start" : "Resume"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1 text-xs"
                  disabled={action.busy !== null}
                  onClick={() =>
                    void run("cancel", () =>
                      api.post(`/api/optimizations/${session.id}/cancel`, {
                        reason: "cancelled from the inspector",
                      }),
                    )
                  }
                  data-testid="optimization-cancel"
                >
                  <Square className="h-3.5 w-3.5" />
                  Cancel
                </Button>
              </>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1 text-xs"
              onClick={() => setManualOpen(true)}
              data-testid="optimization-attach"
            >
              <Hand className="h-3.5 w-3.5" />
              Attach candidate
            </Button>
            <a
              href={`/api/optimizations/${session.id}/export?format=markdown`}
              className="inline-flex h-8 items-center gap-1 rounded-md border px-2.5 text-xs transition-all hover:bg-muted"
              data-testid="optimization-export"
            >
              <Download className="h-3.5 w-3.5" />
              Report
            </a>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 border-t pt-3 sm:grid-cols-3 lg:grid-cols-6">
          <Budget label="Iteration" used={progress.currentIteration} limit={progress.maxIterations} />
          <Budget label="Candidates" used={progress.candidateCount} limit={progress.maxCandidates} />
          <Budget label="Runs" used={progress.runCount} limit={progress.maxRuns} />
          <Budget label="Agent tokens" used={progress.tokenUsage} limit={null} />
          <Budget label="Analyzer tokens" used={progress.analyzerTokenUsage} limit={null} />
          <div className="flex flex-col gap-0.5">
            <span className="text-[10.5px] uppercase tracking-wide text-muted-foreground">
              Est. cost
            </span>
            <span className="text-sm font-medium tabular-nums">
              <MetricValue value={progress.estimatedCostUsd} unit=" USD" />
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs">
          <div className="flex items-center gap-3 text-muted-foreground">
            <span className="flex items-center gap-1">
              <Clock3 className="h-3 w-3" /> {detail.events.length} timeline events
            </span>
            <span>
              {progress.acceptedCandidates} accepted · {progress.rejectedCandidates} rejected ·{" "}
              {progress.invalidCandidates} invalid
            </span>
          </div>
          <StopReasonNote reason={session.stopReason} />
        </div>

        {action.error !== null ? (
          <p className="text-xs text-destructive" data-testid="optimization-action-error">
            {action.error}
          </p>
        ) : null}
      </section>

      {/* --- review gate ------------------------------------------------------ */}
      {session.status === "WAITING_FOR_REVIEW" && pendingCandidate !== undefined ? (
        <section
          className="flex flex-col gap-3 rounded-lg border border-violet-500/30 bg-violet-500/5 p-4"
          data-testid="optimization-review"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                <ShieldCheck className="h-4 w-4" /> Review required before evaluation
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                The loop proposed <span className="font-medium">{pendingCandidate.label}</span> and
                parked itself. Approving evaluates exactly the definition stored with this candidate;
                rejecting spends the hypothesis and lets the loop continue with the next one.
              </p>
            </div>
            <div className="flex gap-1.5">
              <Button
                size="sm"
                className="h-8 gap-1 text-xs"
                disabled={review === null || !review.canApprove || action.busy !== null}
                onClick={() =>
                  void run("approve", () =>
                    api.post(
                      `/api/optimizations/${session.id}/candidates/${pendingCandidate.id}/approve`,
                      {},
                    ),
                  )
                }
                data-testid="optimization-approve"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                Approve and evaluate
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1 text-xs"
                disabled={review === null || !review.canReject || action.busy !== null}
                onClick={() => {
                  const reason = window.prompt("Why is this change rejected?", "");
                  if (reason === null || reason.trim() === "") {
                    return;
                  }
                  void run("reject", () =>
                    api.post(
                      `/api/optimizations/${session.id}/candidates/${pendingCandidate.id}/reject`,
                      { reason: reason.trim() },
                    ),
                  );
                }}
                data-testid="optimization-reject"
              >
                <XCircle className="h-3.5 w-3.5" />
                Reject
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-1 rounded-md border bg-background/60 p-2.5 text-xs">
            {(review?.checks ?? []).map((check) => (
              <p
                key={check.label}
                className={
                  check.status === "blocked"
                    ? "text-destructive"
                    : check.status === "warning"
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-muted-foreground"
                }
              >
                <span className="font-medium">{check.label}:</span> {check.detail}
              </p>
            ))}
          </div>

          <div className="rounded-md border bg-background/60 p-2.5 text-xs">
            <p className="mb-1.5 font-medium">Proposed changes</p>
            <ChangeList
              changes={pendingCandidate.changeSet ?? []}
              mutations={pendingCandidate.mutations}
            />
          </div>
        </section>
      ) : null}

      {/* --- findings --------------------------------------------------------- */}
      <section className="flex flex-col gap-3">
        <SectionHeading
          icon={<AlertTriangle className="h-4 w-4" />}
          title="Failure analysis"
          subtitle={`${detail.findings.length} weakness${detail.findings.length === 1 ? "" : "es"} observed in the evidence batch`}
        />
        {detail.findings.length === 0 ? (
          <EmptyState label="No findings yet — start the session to analyse the evidence." />
        ) : (
          <div className="flex flex-col gap-2">
            {detail.findings.map((finding) => (
              <article key={finding.id} className="rounded-lg border p-3" data-testid="optimization-finding">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[11px] font-semibold text-primary">
                    {finding.category}
                  </span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
                    {finding.frequency ?? "—"}
                  </span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
                    confidence: {finding.confidence}
                    {finding.isLlm ? " (model-shaped)" : ""}
                  </span>
                </div>
                <p className="mt-1.5 text-sm">{finding.summary}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {finding.impact ?? ""} {finding.investigation === null ? "" : `Next: ${finding.investigation}`}
                </p>
                <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
                  <span>
                    cases:{" "}
                    {finding.caseKeys.length === 0
                      ? "—"
                      : finding.caseKeys.slice(0, 8).join(", ")}
                    {finding.caseKeys.length > 8 ? ` (+${finding.caseKeys.length - 8})` : ""}
                  </span>
                  <span>
                    runs:{" "}
                    {finding.runIds.length === 0
                      ? "—"
                      : finding.runIds.map((id) => id.slice(-6)).join(", ")}
                  </span>
                  {finding.traceRefs === null ? null : (
                    <span>{finding.traceRefs.length} trace reference(s)</span>
                  )}
                  {finding.evaluatorKeys.length === 0 ? null : (
                    <span>evaluators: {finding.evaluatorKeys.join(", ")}</span>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* --- hypotheses ------------------------------------------------------- */}
      <section className="flex flex-col gap-3">
        <SectionHeading
          icon={<FileText className="h-4 w-4" />}
          title="Improvement hypotheses"
          subtitle={`${detail.hypotheses.length} testable claim${detail.hypotheses.length === 1 ? "" : "s"}, each with the smallest change that would test it`}
        />
        {detail.hypotheses.length === 0 ? (
          <EmptyState label="No hypotheses yet — they are generated from the findings." />
        ) : (
          <div className="grid gap-2 lg:grid-cols-2">
            {detail.hypotheses.map((hypothesis) => (
              <article
                key={hypothesis.id}
                className="flex flex-col gap-1.5 rounded-lg border p-3 text-xs"
                data-testid="optimization-hypothesis"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">{hypothesis.title}</span>
                  <span className="flex items-center gap-1.5">
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                      {hypothesis.status.toLowerCase()}
                    </span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {hypothesis.confidence}
                    </span>
                  </span>
                </div>
                <Row label="Observation" value={hypothesis.observation} />
                <Row label="Claim" value={hypothesis.hypothesis} />
                <Row label="Change" value={hypothesis.proposedChange} />
                <Row label="Expect" value={hypothesis.expectedOutcome} />
                <Row label="Trade-off" value={hypothesis.tradeoff ?? "—"} />
                <p className="text-[10.5px] text-muted-foreground">
                  category {hypothesis.category} · metrics {hypothesis.metricKeys.join(", ")} ·
                  origin {hypothesis.origin}
                  {hypothesis.requiresReview ? " · human review required" : ""}
                </p>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* --- candidates ------------------------------------------------------- */}
      <section className="flex flex-col gap-3">
        <SectionHeading
          icon={<GitBranch className="h-4 w-4" />}
          title="Candidates"
          subtitle="Every proposed change, its validation, its measurement and its verdict"
        />
        {detail.candidates.length === 0 ? (
          <EmptyState label="No candidates yet — the loop proposes them from the hypotheses." />
        ) : (
          <div className="flex flex-col gap-3" data-testid="optimization-candidates">
            {detail.candidates.map((candidate) => {
              const isRecommended = ranking.leader?.candidateId === candidate.id;
              return (
                <article
                  key={candidate.id}
                  className="rounded-lg border p-3"
                  data-testid="optimization-candidate"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {candidate.label}
                        <OptimizationStatusChip value={candidate.status} />
                        <DecisionChip value={candidate.decisionKind} />
                        {isRecommended ? (
                          <span className="rounded border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                            recommended
                          </span>
                        ) : null}
                      </p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        iteration {candidate.iteration} ·{" "}
                        {candidate.validation === null
                          ? "not validated"
                          : candidate.validation.ok
                            ? `${candidate.validation.nodeCount} nodes / ${candidate.validation.edgeCount} edges`
                            : `${candidate.validation.issues.length} validation issue(s)`}
                        {candidate.harnessVersion === null
                          ? " · no version published"
                          : ` · version v${candidate.harnessVersion}`}
                        {candidate.evaluationBatchId === null
                          ? " · not evaluated"
                          : " · evaluated"}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-1 text-xs">
                      <span className="flex items-center gap-3 tabular-nums">
                        <span>
                          score <MetricValue value={candidate.metrics?.score.mean ?? null} />
                        </span>
                        <span>
                          pass <MetricValue value={candidate.metrics?.passRate ?? null} />
                        </span>
                        <span>
                          cost <MetricValue value={candidate.metrics?.cost.costUsd ?? null} unit=" USD" />
                        </span>
                      </span>
                      {candidate.baselineMetrics === null ? null : (
                        <span className="text-muted-foreground">
                          baseline score <MetricValue value={candidate.baselineMetrics.score.mean} />
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="mt-2 rounded-md border bg-muted/30 p-2.5">
                    <p className="mb-1 text-[11px] font-medium">Change set</p>
                    <ChangeList changes={candidate.changeSet ?? []} mutations={candidate.mutations} />
                    {candidate.validation !== null && !candidate.validation.ok ? (
                      <ul className="mt-1.5 flex flex-col gap-0.5 text-[11px] text-destructive">
                        {candidate.validation.issues.map((issue) => (
                          <li key={`${issue.code}-${issue.message}`}>
                            {issue.code}: {issue.message}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>

                  {candidate.decision !== null ? (
                    <div className="mt-2 rounded-md border p-2.5 text-xs">
                      <p className="mb-1 flex items-center gap-2 font-medium">
                        Acceptance verdict
                        <span className="text-[10.5px] font-normal text-muted-foreground">
                          {candidate.decision.evidenceStrength} evidence ·{" "}
                          {candidate.decision.evidenceCompleteness} coverage ·{" "}
                          {candidate.decision.scoredCases} scored case(s)
                        </span>
                      </p>
                      <ul className="flex flex-col gap-0.5">
                        {candidate.decision.reasons.map((reason) => (
                          <li key={reason} className="text-muted-foreground">
                            • {reason}
                          </li>
                        ))}
                      </ul>
                      {candidate.decision.violations.length > 0 ? (
                        <ul className="mt-1 flex flex-col gap-0.5 text-destructive">
                          {candidate.decision.violations.map((violation) => (
                            <li key={violation.constraint}>⚠ {violation.message}</li>
                          ))}
                        </ul>
                      ) : null}
                      {candidate.decision.deltas.length > 0 ? (
                        <p className="mt-1.5 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
                          {candidate.decision.deltas.map((delta) => (
                            <span key={delta.metric} className="tabular-nums">
                              {delta.metric}: {fmt(delta.baseline)} → {fmt(delta.candidate)}
                            </span>
                          ))}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}

        <PromotePanel detail={detail} busy={action.busy} onRun={run} />
      </section>

      {/* --- timeline --------------------------------------------------------- */}
      <section className="flex flex-col gap-3">
        <SectionHeading
          icon={<RefreshCw className="h-4 w-4" />}
          title="Timeline"
          subtitle="Append-only: every step the loop took, in order"
        />
        <ol className="flex max-h-96 flex-col gap-1 overflow-y-auto rounded-lg border p-3 text-xs">
          {detail.events.length === 0 ? (
            <li className="text-muted-foreground">No events yet.</li>
          ) : (
            detail.events.map((event) => (
              <li key={event.id} className="flex gap-2" data-testid="optimization-event">
                <span className="w-40 shrink-0 font-mono text-[11px] text-muted-foreground">
                  {event.kind}
                </span>
                <span className="min-w-0 flex-1">{event.message}</span>
                <span className="shrink-0 text-[10.5px] text-muted-foreground">
                  {formatRelativeTime(event.createdAt)}
                </span>
              </li>
            ))
          )}
        </ol>
      </section>

      {/* --- report ----------------------------------------------------------- */}
      {session.report !== null ? (
        <section className="flex flex-col gap-3 rounded-lg border p-4">
          <SectionHeading
            icon={<FileText className="h-4 w-4" />}
            title="Optimization report"
            subtitle={`Generated ${formatRelativeTime(session.report.generatedAt)} · ${session.report.status.replace(/_/g, " ").toLowerCase()}`}
          />
          <div className="grid gap-3 text-xs lg:grid-cols-2">
            <div className="rounded-md border p-3">
              <p className="mb-1 font-medium">Recommendation</p>
              <p className="text-muted-foreground">
                {session.report.recommendation.label ?? "No candidate is eligible for promotion."}
              </p>
              <ul className="mt-1 flex flex-col gap-0.5 text-muted-foreground">
                {session.report.recommendation.rationale.map((line) => (
                  <li key={line}>• {line}</li>
                ))}
              </ul>
            </div>
            <div className="rounded-md border p-3">
              <p className="mb-1 font-medium">Outcome</p>
              <ul className="flex flex-col gap-0.5 text-muted-foreground">
                <li>• {session.report.accepted.length} accepted, {session.report.rejected.length} rejected</li>
                <li>
                  • {session.report.usage.runs} run(s) · {session.report.usage.agentTokens} agent
                  tokens · {session.report.usage.analyzerTokens} analyzer tokens
                </li>
                <li>
                  • estimated cost ${session.report.usage.estimatedCostUsd.toFixed(4)}
                </li>
                <li>• {session.report.findings.length} finding(s) carried into the report</li>
              </ul>
            </div>
          </div>
        </section>
      ) : null}

      <ManualCandidateDialog
        open={manualOpen}
        onOpenChange={setManualOpen}
        sessionId={session.id}
        harnessId={session.harnessId}
        onDone={() => {
          setManualOpen(false);
          void queryClient.invalidateQueries({ queryKey: ["optimization", session.id] });
        }}
      />
    </div>
  );
}

// ------------------------------------------------------------------------------
// Pieces
// ------------------------------------------------------------------------------

function fmt(value: number | null): string {
  if (value === null) {
    return "n/a";
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function SectionHeading({
  icon,
  title,
  subtitle,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold">
        {icon}
        {title}
      </h3>
      <p className="text-xs text-muted-foreground">{subtitle}</p>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">
      {label}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <p className="text-xs">
      <span className="text-muted-foreground">{label}: </span>
      {value}
    </p>
  );
}

/**
 * The change set, with before/after.
 *
 * This is the audit surface: an operator can see exactly what a candidate
 * changes without opening a diff, and each row names the risk the mutation
 * engine assigned to it.
 */
function ChangeList({
  changes,
  mutations,
}: {
  changes: Array<{
    operation: string;
    target: string;
    before: unknown;
    after: unknown;
    reason: string;
    risk: string;
  }>;
  mutations: Array<{ id: string; operation: string; target: string; risk: string; applied: boolean }>;
}) {
  return (
    <ul className="flex flex-col gap-1 text-[11px]">
      {changes.length === 0 ? (
        <li className="text-muted-foreground">No typed change recorded.</li>
      ) : (
        changes.map((change, index) => (
          <li key={`${change.operation}-${change.target}-${index}`} className="rounded border bg-background/60 p-2">
            <div className="flex flex-wrap items-center gap-2">
              <code className="font-mono text-[10.5px] font-semibold">{change.operation}</code>
              <code className="font-mono text-[10.5px] text-muted-foreground">{change.target}</code>
              <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                risk {change.risk}
              </span>
              {mutations.some((mutation) => mutation.target === change.target && !mutation.applied) ? (
                <span className="rounded bg-destructive/10 px-1 py-0.5 text-[10px] text-destructive">
                  not applied
                </span>
              ) : null}
            </div>
            <p className="mt-1 break-all text-muted-foreground">
              <span className="font-medium text-foreground">before:</span> {preview(change.before)}
            </p>
            <p className="break-all text-muted-foreground">
              <span className="font-medium text-foreground">after:</span> {preview(change.after)}
            </p>
            <p className="mt-0.5 text-muted-foreground">{change.reason}</p>
          </li>
        ))
      )}
    </ul>
  );
}

function preview(value: unknown): string {
  if (value === null || value === undefined) {
    return "—";
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 220 ? `${text.slice(0, 220)}…` : text;
}

/**
 * Promotion.
 *
 * The only control that changes an active harness version. It is disabled until
 * a settled session has an accepted candidate with a published version and a
 * sealed batch, and the server re-checks all of that before it acts.
 */
function PromotePanel({
  detail,
  busy,
  onRun,
}: {
  detail: OptimizationDetailJson;
  busy: string | null;
  onRun: (key: string, request: () => Promise<unknown>) => Promise<void>;
}) {
  const { session, ranking, candidates } = detail;
  const recommended = candidates.find(
    (candidate) => candidate.id === ranking.leader?.candidateId,
  );
  const promotable =
    recommended !== undefined &&
    recommended.decisionKind === "ACCEPT" &&
    recommended.versionId !== null &&
    recommended.evaluationBatchId !== null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
      <div className="text-xs text-muted-foreground">
        {recommended === undefined ? (
          <span>No candidate is ranked yet — the ranking needs at least one evaluated candidate.</span>
        ) : (
          <span>
            Ranked leader: <span className="font-medium text-foreground">{recommended.label}</span>{" "}
            {promotable
              ? "— clearing the gates below advances the harness to its immutable version."
              : "— promotion is blocked until the session is settled with this candidate accepted."}
          </span>
        )}
      </div>
      <Button
        size="sm"
        className="h-8 gap-1 text-xs"
        disabled={!promotable || busy !== null}
        onClick={() => {
          const notes = window.prompt(
            "Record why this candidate is being promoted:",
            "Best accepted candidate on the evidence.",
          );
          if (notes === null || notes.trim() === "") {
            return;
          }
          void onRun("promote", () =>
            api.post(`/api/optimizations/${session.id}/promote`, {
              candidateId: recommended?.id,
              notes: notes.trim(),
            }),
          );
        }}
        data-testid="optimization-promote"
      >
        <CheckCircle2 className="h-3.5 w-3.5" />
        Promote recommended candidate
      </Button>
    </div>
  );
}

/**
 * Attaching a hand-built candidate (Strategy 3).
 *
 * The version is chosen from the harness's own published versions; attaching is
 * itself the approval, so the next pass evaluates that version like any proposed
 * candidate.
 */
function ManualCandidateDialog({
  open,
  onOpenChange,
  sessionId,
  harnessId,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  harnessId: string;
  onDone: () => void;
}) {
  const [versionId, setVersionId] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const versionsQuery = useQuery({
    queryKey: ["optimization-versions", harnessId],
    queryFn: () =>
      api.get<{ versions: Array<{ id: string; version: number; name: string }> }>(
        `/api/harnesses/${harnessId}/versions`,
      ),
    enabled: open,
  });

  async function attach(): Promise<void> {
    if (versionId === "") {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/optimizations/${sessionId}/candidates/manual`, {
        harnessVersionId: versionId,
        ...(label.trim() === "" ? {} : { label: label.trim() }),
      });
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm font-medium">Attach a hand-built candidate</DialogTitle>
          <DialogDescription className="text-xs">
            Choose an already-published version of this harness. Attaching is itself the approval: the
            next pass evaluates it over the dataset and evaluators the session was sealed with.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Published version</span>
            <select
              className="h-8 w-full rounded-md border bg-transparent px-2 text-xs shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
              value={versionId}
              onChange={(event) => setVersionId(event.target.value)}
              data-testid="optimization-manual-version"
            >
              <option value="">Choose a version…</option>
              {(versionsQuery.data?.versions ?? []).map((version) => (
                <option key={version.id} value={version.id}>
                  v{version.version} — {version.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Label (optional)</span>
            <Input
              className="h-8 text-xs"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Hand-built verification step"
            />
          </label>
          {error !== null ? <p className="text-destructive">{error}</p> : null}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-8 gap-1 text-xs"
            disabled={versionId === "" || busy}
            onClick={() => void attach()}
            data-testid="optimization-manual-attach"
          >
            <Hand className="h-3.5 w-3.5" />
            {busy ? "Attaching…" : "Attach"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
