"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Filter, RefreshCw, RotateCcw } from "lucide-react";
import { api, errorMessage } from "@/lib/api/client";
import { OrbitFavicon } from "@/components/brand/orbit-favicon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  RunStatusChip,
  formatCost,
  formatDuration,
  formatRelativeTime,
  formatTokens,
} from "@/components/run-status";

export interface RunListRowDto {
  id: string;
  status: string;
  harnessId: string;
  harnessName: string;
  harnessVersionLabel: number | null;
  agentId: string | null;
  agentName: string | null;
  attempt: number;
  retryOfRunId: string | null;
  inputPreview: string;
  outputPreview: string | null;
  errorCode: string | null;
  totalTokens: number;
  cost: number | null;
  costKnown: boolean;
  durationMs: number | null;
  stepCount: number;
  createdAt: string;
}

export interface RunFilterOption {
  id: string;
  name: string;
}

/**
 * A run the runtime is still working on: worth polling for, and — since the tab
 * icon is the one piece of chrome that stays visible when the page is scrolled
 * away — worth animating. The node keeps orbiting the harness while work is in
 * flight, and stops when it lands.
 */
function isRunActive(run: RunListRowDto): boolean {
  return run.status === "RUNNING" || run.status === "QUEUED";
}

interface RunsResponse {
  runs: RunListRowDto[];
  total: number;
  limit: number;
  offset: number;
}

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "All statuses" },
  { value: "RUNNING", label: "Running" },
  { value: "QUEUED", label: "Queued" },
  { value: "SUCCEEDED", label: "Completed" },
  { value: "FAILED", label: "Failed" },
  { value: "CANCELLED", label: "Cancelled" },
  { value: "TIMED_OUT", label: "Timed out" },
];

const PAGE_SIZE = 20;

/**
 * Run history with filters (status, harness, agent, date) and pagination.
 *
 * Filtering happens on the server (query params), so the client never receives
 * rows the caller may not see. Repeated runs of the same harness re-render from
 * a fresh fetch; there is no optimistic mutation of history.
 */
export function RunsView({
  initialRuns,
  initialTotal,
  harnesses,
  agents,
  lockedHarnessId,
  lockedAgentId,
}: {
  initialRuns: RunListRowDto[];
  initialTotal: number;
  harnesses: RunFilterOption[];
  agents: RunFilterOption[];
  lockedHarnessId?: string;
  lockedAgentId?: string;
}) {
  const [status, setStatus] = useState("");
  const [harnessId, setHarnessId] = useState(lockedHarnessId ?? "");
  const [agentId, setAgentId] = useState(lockedAgentId ?? "");
  const [since, setSince] = useState("");
  const [offset, setOffset] = useState(0);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (status !== "") {
      params.set("status", status);
    }
    if (harnessId !== "") {
      params.set("harnessId", harnessId);
    }
    if (agentId !== "") {
      params.set("agentId", agentId);
    }
    if (since !== "") {
      params.set("since", new Date(since).toISOString());
    }
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String(offset));
    return params.toString();
  }, [status, harnessId, agentId, since, offset]);

  const isDefaultView = query === `limit=${PAGE_SIZE}&offset=0`;

  const runsQuery = useQuery({
    queryKey: ["runs", query],
    queryFn: () => api.get<RunsResponse>(`/api/runs?${query}`),
    enabled: !isDefaultView,
    refetchInterval: (result) =>
      (result.state.data?.runs ?? []).some(isRunActive) ? 4_000 : false,
  });

  const rows = isDefaultView ? initialRuns : (runsQuery.data?.runs ?? []);
  const hasActiveRuns = rows.some(isRunActive);
  const total = isDefaultView ? initialTotal : (runsQuery.data?.total ?? 0);
  const loading = !isDefaultView && runsQuery.isLoading;
  const hasFilters = status !== "" || harnessId !== "" || agentId !== "" || since !== "";

  function resetFilters(): void {
    setStatus("");
    setHarnessId(lockedHarnessId ?? "");
    setAgentId(lockedAgentId ?? "");
    setSince("");
    setOffset(0);
  }

  return (
    <div className="flex flex-col gap-4">
      <OrbitFavicon active={hasActiveRuns} />

      <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3">
        <div className="flex items-center gap-1.5 pb-1 text-xs font-medium text-muted-foreground">
          <Filter className="h-3.5 w-3.5" />
          Filters
        </div>

        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          Status
          <select
            value={status}
            data-testid="runs-filter-status"
            onChange={(event) => {
              setStatus(event.target.value);
              setOffset(0);
            }}
            className="h-8 rounded-md border bg-transparent px-2 text-sm text-foreground shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
          >
            {STATUS_FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          Harness
          <select
            value={harnessId}
            data-testid="runs-filter-harness"
            disabled={lockedHarnessId !== undefined}
            onChange={(event) => {
              setHarnessId(event.target.value);
              setOffset(0);
            }}
            className="h-8 min-w-40 rounded-md border bg-transparent px-2 text-sm text-foreground shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:opacity-60"
          >
            <option value="">All harnesses</option>
            {harnesses.map((harness) => (
              <option key={harness.id} value={harness.id}>
                {harness.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          Agent
          <select
            value={agentId}
            data-testid="runs-filter-agent"
            disabled={lockedAgentId !== undefined}
            onChange={(event) => {
              setAgentId(event.target.value);
              setOffset(0);
            }}
            className="h-8 min-w-36 rounded-md border bg-transparent px-2 text-sm text-foreground shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:opacity-60"
          >
            <option value="">All agents</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          Created after
          <Input
            type="date"
            value={since}
            data-testid="runs-filter-since"
            onChange={(event) => {
              setSince(event.target.value);
              setOffset(0);
            }}
            className="h-8 w-40"
          />
        </label>

        {hasFilters ? (
          <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs" onClick={resetFilters}>
            <RotateCcw className="h-3 w-3" />
            Reset
          </Button>
        ) : null}
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading runs…</p>
      ) : runsQuery.isError ? (
        <p className="text-sm text-destructive">{errorMessage(runsQuery.error)}</p>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-14 text-center">
          <p className="text-sm font-medium">
            {hasFilters ? "No runs match these filters" : "No runs yet"}
          </p>
          <p className="max-w-md text-sm text-muted-foreground">
            {hasFilters
              ? "Try a wider date range or a different status."
              : "Run a harness from the builder (▶ Run) and its timeline, trace and usage will appear here."}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border" data-testid="runs-table">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Run</th>
                <th className="px-4 py-2 font-medium">Harness</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Steps</th>
                <th className="px-4 py-2 font-medium">Duration</th>
                <th className="px-4 py-2 font-medium">Tokens</th>
                <th className="px-4 py-2 font-medium">Cost</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((run) => (
                <tr
                  key={run.id}
                  className="border-b last:border-b-0 hover:bg-muted/30"
                  data-testid={`run-row-${run.id}`}
                >
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/dashboard/runs/${run.id}`}
                      className="font-mono text-xs font-medium hover:underline"
                    >
                      #{run.id.slice(-6)}
                    </Link>
                    <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                      {formatRelativeTime(run.createdAt)}
                      {run.attempt > 1 ? ` · attempt ${run.attempt}` : ""}
                      {run.retryOfRunId !== null ? " · retry" : ""}
                    </p>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="text-xs">{run.harnessName}</span>
                    <span className="ml-1.5 font-mono text-[10.5px] text-muted-foreground">
                      v{run.harnessVersionLabel ?? "?"}
                    </span>
                    {run.agentName !== null ? (
                      <p className="mt-0.5 text-[10.5px] text-muted-foreground">{run.agentName}</p>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5">
                    <RunStatusChip status={run.status} />
                    {run.errorCode !== null ? (
                      <p className="mt-1 font-mono text-[10px] text-destructive">{run.errorCode}</p>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">{run.stepCount}</td>
                  <td className="px-4 py-2.5 font-mono text-xs">
                    {formatDuration(run.durationMs)}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs">
                    {run.totalTokens === 0 ? "—" : formatTokens(run.totalTokens)}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs">
                    {formatCost(run.cost, !run.costKnown && run.totalTokens > 0)}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Button asChild variant="ghost" size="sm" className="h-7 gap-1 text-xs">
                      <Link href={`/dashboard/runs/${run.id}`}>
                        Open
                        <ChevronRight className="h-3 w-3" />
                      </Link>
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <RefreshCw className="h-3 w-3" />
          {total} run{total === 1 ? "" : "s"}
          {rows.some((run) => run.status === "RUNNING" || run.status === "QUEUED")
            ? " · refreshing while runs are active"
            : ""}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
