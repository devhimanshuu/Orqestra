"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Ban,
  ChevronDown,
  ChevronRight,
  Cpu,
  Loader2,
  Radio,
  RotateCcw,
  Wrench,
} from "lucide-react";
import { api, errorMessage } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  RunStatusChip,
  formatCost,
  formatDuration,
  formatRelativeTime,
  formatTokens,
} from "@/components/run-status";

export interface RunStepDto {
  id: string;
  index: number;
  nodeId: string;
  nodeType: string;
  nodeLabel: string;
  status: string;
  input: unknown;
  output: unknown;
  error: { code: string; message: string; retryable?: boolean; nodeId?: string } | null;
  metadata: Record<string, unknown> | null;
  iteration: number | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
}

export interface RunUsageDto {
  provider: string;
  model: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number | null;
}

export interface RunDetailDto {
  id: string;
  status: string;
  attempt: number;
  retryOfRunId: string | null;
  input: unknown;
  output: unknown | null;
  error: { code: string; message: string; retryable?: boolean; nodeId?: string } | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  latencyMs: number | null;
  cancelRequestedAt: string | null;
  metadata: Record<string, unknown> | null;
  harnessId: string;
  harnessVersionId: string;
  agentId: string | null;
}

interface RunDetailResponse {
  run: RunDetailDto;
  steps: RunStepDto[];
  usage: RunUsageDto[];
  usageTotal: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsd: number | null;
    unknownCost: boolean;
  };
  harness: { id: string; name: string; slug: string };
  harnessVersionLabel: number | null;
  agent: { id: string; name: string } | null;
  live: boolean;
}

/**
 * Run detail: status, timeline, node details, usage and live updates.
 *
 * Live updates use SSE (`/api/runs/:id/events`); the initial render is the
 * server-fetched snapshot, so the page is useful before (and without) the
 * stream. Events are applied by `seq`, and a terminal event triggers one
 * authoritative refetch — the stream is a notification channel, not a second
 * source of truth.
 */
export function RunDetailView({ runId, initial }: { runId: string; initial: RunDetailResponse }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [streamConnected, setStreamConnected] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const lastSeq = useRef(0);

  const runQuery = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.get<RunDetailResponse>(`/api/runs/${runId}`),
    initialData: initial,
    refetchInterval: (query) =>
      query.state.data?.live === true ? 5_000 : false,
  });

  const detail = runQuery.data ?? initial;
  const live = detail.live;

  function applyEvent(event: { seq: number; type: string }): void {
    if (event.seq <= lastSeq.current) {
      return;
    }
    lastSeq.current = event.seq;
    // Live events only trigger a refetch: the database is the source of truth,
    // so a dropped or out-of-order event can never corrupt the view.
    void queryClient.invalidateQueries({ queryKey: ["run", runId] });
    if (event.type.startsWith("RUN_")) {
      router.refresh();
    }
  }

  useEffect(() => {
    if (!live) {
      return;
    }
    let cancelled = false;
    const source = new EventSource(`/api/runs/${runId}/events`);

    source.onopen = () => {
      if (!cancelled) {
        setStreamConnected(true);
      }
    };
    source.onerror = () => {
      if (!cancelled) {
        setStreamConnected(false);
      }
    };
    source.onmessage = (message) => {
      try {
        applyEvent(JSON.parse(message.data) as { seq: number; type: string });
      } catch {
        // A malformed frame is ignored; the poll interval covers it.
      }
    };
    // Named events (`event: NODE_COMPLETED`) do not fire `onmessage`.
    const handler = (message: MessageEvent): void => {
      try {
        applyEvent(JSON.parse(message.data) as { seq: number; type: string });
      } catch {
        // Ignored.
      }
    };
    for (const type of [
      "RUN_CREATED",
      "RUN_STARTED",
      "NODE_STARTED",
      "NODE_COMPLETED",
      "NODE_FAILED",
      "LLM_STARTED",
      "LLM_COMPLETED",
      "LLM_FAILED",
      "TOOL_STARTED",
      "TOOL_COMPLETED",
      "TOOL_FAILED",
      "LOOP_STARTED",
      "LOOP_ITERATION",
      "LIMIT_EXCEEDED",
      "RUN_COMPLETED",
      "RUN_FAILED",
      "RUN_CANCELLED",
      "RUN_TIMED_OUT",
    ]) {
      source.addEventListener(type, handler as EventListener);
    }

    return () => {
      cancelled = true;
      source.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, live]);

  const cancelMutation = useMutation({
    mutationFn: () => api.post(`/api/runs/${runId}/cancel`, {}),
    onSuccess: () => {
      setNotice("Cancellation requested — the runtime stops at the next checkpoint.");
      void queryClient.invalidateQueries({ queryKey: ["run", runId] });
    },
    onError: (error) => setNotice(errorMessage(error)),
  });

  const retryMutation = useMutation({
    mutationFn: () => api.post<{ run: { id: string } }>(`/api/runs/${runId}/retry`, {}),
    onSuccess: (result) => router.push(`/dashboard/runs/${result.run.id}`),
    onError: (error) => setNotice(errorMessage(error)),
  });

  const steps = detail.steps;
  const failureStep = detail.run.error?.nodeId
    ? steps.find((step) => step.nodeId === detail.run.error?.nodeId)
    : steps.find((step) => step.status === "FAILED");

  const metadata = useMemo(() => {
    const raw = detail.run.metadata ?? {};
    const limits = (raw["limits"] ?? {}) as Record<string, unknown>;
    return {
      engineVersion: typeof raw["engineVersion"] === "string" ? raw["engineVersion"] : null,
      contentHash: typeof raw["harnessContentHash"] === "string" ? raw["harnessContentHash"] : null,
      model: typeof raw["model"] === "string" ? raw["model"] : null,
      provider: typeof raw["provider"] === "string" ? raw["provider"] : null,
      executionMode: typeof raw["executionMode"] === "string" ? raw["executionMode"] : null,
      allowedTools: Array.isArray(raw["allowedTools"]) ? (raw["allowedTools"] as string[]) : [],
      maxDurationMs: typeof limits["maxDurationMs"] === "number" ? limits["maxDurationMs"] : null,
      maxNodes: typeof limits["maxNodes"] === "number" ? limits["maxNodes"] : null,
      maxIterations: typeof limits["maxIterations"] === "number" ? limits["maxIterations"] : null,
      maxLlmCalls: typeof limits["maxLlmCalls"] === "number" ? limits["maxLlmCalls"] : null,
      maxToolCalls: typeof limits["maxToolCalls"] === "number" ? limits["maxToolCalls"] : null,
    };
  }, [detail.run.metadata]);

  const durationMs =
    detail.run.latencyMs ??
    (detail.run.startedAt !== null && detail.run.completedAt !== null
      ? new Date(detail.run.completedAt).getTime() - new Date(detail.run.startedAt).getTime()
      : null);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-mono text-xl font-semibold tracking-tight">#{runId.slice(-6)}</h1>
            <RunStatusChip status={detail.run.status} />
            {detail.run.attempt > 1 ? (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10.5px] text-muted-foreground">
                attempt {detail.run.attempt}
              </span>
            ) : null}
            {live ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10.5px] font-medium text-primary">
                <Radio className={cn("h-3 w-3", streamConnected ? "animate-pulse" : "")} />
                {streamConnected ? "live" : "polling"}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {detail.harness.name} v{detail.harnessVersionLabel ?? "?"}
            {detail.agent !== null ? ` · ${detail.agent.name}` : ""} ·{" "}
            {formatRelativeTime(detail.run.createdAt)} · {formatDuration(durationMs)}
          </p>
          {detail.run.retryOfRunId !== null ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Retry of{" "}
              <Link
                href={`/dashboard/runs/${detail.run.retryOfRunId}`}
                className="font-mono hover:underline"
              >
                #{detail.run.retryOfRunId.slice(-6)}
              </Link>
            </p>
          ) : null}
        </div>

        <div className="flex gap-2">
          {live ? (
            <Button
              variant="outline"
              data-testid="cancel-run"
              disabled={cancelMutation.isPending || detail.run.cancelRequestedAt !== null}
              onClick={() => cancelMutation.mutate()}
            >
              {cancelMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Ban className="h-3.5 w-3.5" />
              )}
              {detail.run.cancelRequestedAt !== null ? "Cancelling…" : "Cancel run"}
            </Button>
          ) : null}
          <Button
            variant={detail.run.status === "FAILED" ? "default" : "outline"}
            data-testid="retry-run"
            disabled={retryMutation.isPending}
            onClick={() => retryMutation.mutate()}
          >
            {retryMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCcw className="h-3.5 w-3.5" />
            )}
            Retry run
          </Button>
        </div>
      </header>

      {notice !== null ? (
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs" role="status">
          {notice}
        </p>
      ) : null}

      {detail.run.error !== null ? (
        <section
          className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4"
          data-testid="run-error"
        >
          <div className="flex items-center gap-2 text-sm font-semibold text-destructive">
            <AlertTriangle className="h-4 w-4" />
            Run {detail.run.status === "TIMED_OUT" ? "timed out" : "failed"}
          </div>
          <dl className="grid gap-1 text-xs sm:grid-cols-[80px_1fr]">
            <dt className="text-muted-foreground">Node</dt>
            <dd className="font-mono">
              {failureStep !== undefined
                ? `${failureStep.nodeLabel} (${failureStep.nodeId})`
                : (detail.run.error.nodeId ?? "—")}
            </dd>
            <dt className="text-muted-foreground">Reason</dt>
            <dd>{detail.run.error.message}</dd>
            <dt className="text-muted-foreground">Code</dt>
            <dd className="font-mono">{detail.run.error.code}</dd>
            <dt className="text-muted-foreground">Retryable</dt>
            <dd>{detail.run.error.retryable === true ? "Yes" : "No"}</dd>
          </dl>
          <p className="text-[11px] text-muted-foreground">
            Retrying creates a new run with the same harness version, agent version and input — this
            run stays exactly as it is.
          </p>
        </section>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-4">
        <Metric label="Duration" value={formatDuration(durationMs)} />
        <Metric
          label="Tokens"
          value={
            detail.usageTotal.totalTokens === 0
              ? "—"
              : `${formatTokens(detail.usageTotal.totalTokens)}`
          }
          hint={
            detail.usageTotal.totalTokens === 0
              ? undefined
              : `${formatTokens(detail.usageTotal.promptTokens)} in · ${formatTokens(
                  detail.usageTotal.completionTokens,
                )} out`
          }
        />
        <Metric
          label="Model calls"
          value={String(detail.usageTotal.calls)}
          hint={metadata.model ?? undefined}
        />
        <Metric
          label="Cost"
          value={formatCost(detail.usageTotal.costUsd, detail.usageTotal.unknownCost)}
          hint={detail.usageTotal.unknownCost ? "includes models without a price" : undefined}
        />
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight">Execution timeline</h2>
          <p className="text-xs text-muted-foreground">
            {steps.length} step{steps.length === 1 ? "" : "s"} · {metadata.executionMode ?? "unknown"} mode
          </p>
        </div>

        {steps.length === 0 ? (
          <div className="rounded-lg border border-dashed px-6 py-10 text-center text-sm text-muted-foreground">
            {live ? "Waiting for the first node…" : "This run produced no steps."}
          </div>
        ) : (
          <ol className="flex flex-col gap-2" data-testid="run-timeline">
            {steps.map((step) => (
              <li key={step.id} className="rounded-lg border" data-testid={`run-step-${step.nodeId}`}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
                  onClick={() => setExpanded(expanded === step.id ? null : step.id)}
                >
                  {expanded === step.id ? (
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <StepIcon nodeType={step.nodeType} status={step.status} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{step.nodeLabel}</span>
                      <span className="font-mono text-[10.5px] text-muted-foreground">
                        {step.nodeType}
                      </span>
                      {step.iteration !== null ? (
                        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                          iter {step.iteration}
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                      {step.status.toLowerCase()}
                      {step.status === "FAILED" && step.error !== null
                        ? ` — ${step.error.message}`
                        : ""}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {formatDuration(step.durationMs)}
                  </span>
                </button>

                {expanded === step.id ? (
                  <div className="border-t px-3 py-3">
                    <dl className="grid gap-3 text-xs sm:grid-cols-2">
                      <DetailBlock label="Input" value={step.input} />
                      <DetailBlock label="Output" value={step.output} />
                      <DetailBlock label="Configuration & metadata" value={step.metadata} />
                      <div className="flex flex-col gap-1">
                        <dt className="text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
                          Timing
                        </dt>
                        <dd className="font-mono text-[11px]">
                          {step.startedAt !== null ? new Date(step.startedAt).toLocaleTimeString() : "—"}
                          {" → "}
                          {step.completedAt !== null
                            ? new Date(step.completedAt).toLocaleTimeString()
                            : "—"}
                          {" · "}
                          {formatDuration(step.durationMs)}
                        </dd>
                        {step.error !== null ? (
                          <dd className="mt-1 text-destructive">
                            <span className="font-mono">{step.error.code}</span> {step.error.message}
                          </dd>
                        ) : null}
                      </div>
                    </dl>
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold tracking-tight">Input / output</h2>
          <div className="rounded-lg border p-3">
            <p className="text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
              Task
            </p>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">
              {typeof detail.run.input === "string"
                ? detail.run.input
                : JSON.stringify(detail.run.input, null, 2)}
            </pre>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
              Result
            </p>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
              {detail.run.output === null || detail.run.output === undefined
                ? live
                  ? "Running…"
                  : "No output"
                : typeof detail.run.output === "string"
                  ? detail.run.output
                  : JSON.stringify(detail.run.output, null, 2)}
            </pre>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold tracking-tight">Usage</h2>
          {detail.usage.length === 0 ? (
            <p className="text-sm text-muted-foreground">No model calls recorded for this run.</p>
          ) : (
            <div className="overflow-hidden rounded-lg border">
              <table className="w-full text-left text-xs">
                <thead className="border-b bg-muted/40 text-[10.5px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Model</th>
                    <th className="px-3 py-2 font-medium">Calls</th>
                    <th className="px-3 py-2 font-medium">Tokens</th>
                    <th className="px-3 py-2 font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.usage.map((entry) => (
                    <tr key={`${entry.provider}:${entry.model}`} className="border-b last:border-b-0">
                      <td className="px-3 py-2 font-mono">
                        {entry.provider}:{entry.model}
                      </td>
                      <td className="px-3 py-2">{entry.calls}</td>
                      <td className="px-3 py-2">
                        {formatTokens(entry.totalTokens)}
                        <span className="ml-1 text-muted-foreground">
                          ({formatTokens(entry.promptTokens)}/{formatTokens(entry.completionTokens)})
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono">
                        {formatCost(entry.costUsd, entry.costUsd === null)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="rounded-lg border p-3 text-xs">
            <p className="text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
              Reproducibility
            </p>
            <dl className="mt-1 grid gap-1 sm:grid-cols-[110px_1fr]">
              <dt className="text-muted-foreground">Harness version</dt>
              <dd className="font-mono">v{detail.harnessVersionLabel ?? "?"}</dd>
              <dt className="text-muted-foreground">Content hash</dt>
              <dd className="truncate font-mono" title={metadata.contentHash ?? ""}>
                {metadata.contentHash?.slice(0, 16) ?? "—"}
              </dd>
              <dt className="text-muted-foreground">Runtime</dt>
              <dd className="font-mono">{metadata.engineVersion ?? "—"}</dd>
              <dt className="text-muted-foreground">Provider / model</dt>
              <dd className="font-mono">
                {metadata.provider !== null || metadata.model !== null
                  ? `${metadata.provider ?? "?"}:${metadata.model ?? "?"}`
                  : "—"}
              </dd>
              <dt className="text-muted-foreground">Limits</dt>
              <dd className="font-mono">
                {metadata.maxDurationMs ?? "?"}ms · {metadata.maxNodes ?? "?"} nodes ·{" "}
                {metadata.maxIterations ?? "?"} iterations · {metadata.maxLlmCalls ?? "?"} LLM ·{" "}
                {metadata.maxToolCalls ?? "?"} tools
              </dd>
              <dt className="text-muted-foreground">Allowed tools</dt>
              <dd className="font-mono">
                {metadata.allowedTools.length === 0 ? "no allowlist" : metadata.allowedTools.join(", ")}
              </dd>
            </dl>
          </div>
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 truncate font-mono text-sm font-semibold" title={value}>
        {value}
      </p>
      {hint !== undefined ? (
        <p className="mt-1 truncate text-[10.5px] text-muted-foreground" title={hint}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function StepIcon({ nodeType, status }: { nodeType: string; status: string }) {
  if (status === "FAILED") {
    return <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />;
  }
  if (status === "RUNNING") {
    return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />;
  }
  if (nodeType === "tool") {
    return <Wrench className="h-3.5 w-3.5 shrink-0 text-sky-600 dark:text-sky-400" />;
  }
  if (["model", "planner", "critic", "evaluator"].includes(nodeType)) {
    return <Cpu className="h-3.5 w-3.5 shrink-0 text-violet-600 dark:text-violet-400" />;
  }
  return <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-muted-foreground/40" />;
}

function DetailBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd>
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 text-[11px]">
          {value === null || value === undefined
            ? "—"
            : typeof value === "string"
              ? value
              : JSON.stringify(value, null, 2)}
        </pre>
      </dd>
    </div>
  );
}
