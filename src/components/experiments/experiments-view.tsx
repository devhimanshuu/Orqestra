"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Beaker, ChevronRight, Plus, RefreshCw } from "lucide-react";
import { api, errorMessage } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatRelativeTime } from "@/components/run-status";
import { ProgressBar, ExperimentStatusChip, metricLabel } from "./shared";
import { ExperimentWizard } from "./experiment-wizard";

export interface ExperimentRowDto {
  id: string;
  name: string;
  status: string;
  agentName: string;
  candidateCount: number;
  caseCount: number;
  plannedRunCount: number;
  datasetName: string;
  datasetVersion: number;
  baselineHarnessVersion: number | null;
  primaryMetric: string;
  primaryDirection: "maximize" | "minimize";
  leadingCandidateLabel: string | null;
  leaderNote: string | null;
  completedExecutions: number;
  failedExecutions: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

interface ExperimentsResponse {
  items: ExperimentRowDto[];
  total: number;
  limit: number;
  offset: number;
}

const STATUS_FILTERS = [
  "",
  "DRAFT",
  "QUEUED",
  "RUNNING",
  "PAUSED",
  "COMPLETED",
  "PARTIALLY_COMPLETED",
  "FAILED",
  "CANCELLED",
];

function isActive(status: string): boolean {
  return status === "QUEUED" || status === "RUNNING" || status === "PAUSED";
}

/**
 * The experiments table.
 *
 * A leader is shown only when the stored results support one: the column renders
 * the ranking's own note otherwise ("provisional — 3 executions outstanding"),
 * so the list can never imply a winner the evidence does not name.
 */
export function ExperimentsView({
  projects,
  initialExperiments,
}: {
  projects: { id: string; name: string }[];
  initialExperiments: ExperimentRowDto[];
}) {
  const router = useRouter();
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"createdAt" | "name" | "status" | "progress">("createdAt");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [wizardOpen, setWizardOpen] = useState(false);

  const query = useQuery({
    queryKey: ["experiments", status, search, sort, order],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "50", sort, order });
      if (status !== "") {
        params.set("status", status);
      }
      if (search.trim() !== "") {
        params.set("q", search.trim());
      }
      return api.get<ExperimentsResponse>(`/api/experiments?${params.toString()}`);
    },
    initialData:
      status === "" && search.trim() === "" && sort === "createdAt" && order === "desc"
        ? { items: initialExperiments, total: initialExperiments.length, limit: 50, offset: 0 }
        : undefined,
    refetchInterval: (data) =>
      (data.state.data?.items ?? []).some((row) => isActive(row.status)) ? 5_000 : false,
  });

  const rows = query.data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search experiments…"
            className="h-8 w-56 text-xs"
            data-testid="experiments-search"
          />
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            data-testid="experiments-status-filter"
            className="h-8 rounded-md border bg-transparent px-2 text-xs shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
          >
            {STATUS_FILTERS.map((value) => (
              <option key={value} value={value}>
                {value === "" ? "All statuses" : value.replace(/_/g, " ").toLowerCase()}
              </option>
            ))}
          </select>
          <select
            value={`${sort}:${order}`}
            onChange={(event) => {
              const [nextSort, nextOrder] = event.target.value.split(":");
              setSort(nextSort as "createdAt" | "name" | "status" | "progress");
              setOrder(nextOrder === "asc" ? "asc" : "desc");
            }}
            data-testid="experiments-sort"
            className="h-8 rounded-md border bg-transparent px-2 text-xs shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
          >
            <option value="createdAt:desc">Newest first</option>
            <option value="createdAt:asc">Oldest first</option>
            <option value="name:asc">Name (A–Z)</option>
            <option value="status:asc">Status</option>
            <option value="progress:desc">Progress</option>
          </select>
          {query.isFetching ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <RefreshCw className="h-3 w-3 animate-spin" /> Refreshing…
            </span>
          ) : null}
        </div>

        <Button
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={() => setWizardOpen(true)}
          data-testid="experiment-new"
        >
          <Plus className="h-3.5 w-3.5" />
          New experiment
        </Button>
      </div>

      {query.isError ? <p className="text-xs text-destructive">{errorMessage(query.error)}</p> : null}

      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-14 text-center">
          <Beaker className="h-5 w-5 text-muted-foreground" />
          <p className="text-sm font-medium">No experiments yet</p>
          <p className="max-w-xl text-sm text-muted-foreground">
            An experiment runs a baseline harness version and one or more candidates over the same
            dataset version, with the same evaluators and the same objective — then ranks them by
            evidence, not by a single score.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border" data-testid="experiments-table">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Experiment</th>
                <th className="px-4 py-2 font-medium">Agent</th>
                <th className="px-4 py-2 font-medium">Baseline</th>
                <th className="px-4 py-2 font-medium">Candidates</th>
                <th className="px-4 py-2 font-medium">Dataset</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Progress</th>
                <th className="px-4 py-2 font-medium">Primary metric</th>
                <th className="px-4 py-2 font-medium">Leading</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b last:border-b-0 hover:bg-muted/30">
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/dashboard/experiments/${row.id}`}
                      className="text-sm font-medium hover:underline"
                    >
                      {row.name}
                    </Link>
                    <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                      {formatRelativeTime(row.createdAt)}
                    </p>
                  </td>
                  <td className="px-4 py-2.5 text-xs">{row.agentName}</td>
                  <td className="px-4 py-2.5 text-xs font-mono">
                    {row.baselineHarnessVersion === null ? "—" : `v${row.baselineHarnessVersion}`}
                  </td>
                  <td className="px-4 py-2.5 text-xs font-mono">{row.candidateCount}</td>
                  <td className="px-4 py-2.5 text-xs">
                    {row.datasetName}
                    <span className="ml-1 font-mono text-[10.5px] text-muted-foreground">
                      v{row.datasetVersion}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <ExperimentStatusChip value={row.status} />
                    {row.failedExecutions > 0 ? (
                      <p className="mt-1 text-[10.5px] text-destructive">
                        {row.failedExecutions} failed execution
                        {row.failedExecutions === 1 ? "" : "s"}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5">
                    <ProgressBar
                      percent={row.plannedRunCount === 0 ? 0 : row.completedExecutions / row.plannedRunCount}
                      label={`${row.completedExecutions}/${row.plannedRunCount}`}
                    />
                  </td>
                  <td className="px-4 py-2.5 text-xs">
                    {metricLabel(row.primaryMetric)}
                    <span className="ml-1 text-[10.5px] text-muted-foreground">
                      {row.primaryDirection === "maximize" ? "↑" : "↓"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs">
                    {row.leadingCandidateLabel !== null ? (
                      <span className="font-medium">{row.leadingCandidateLabel}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                    {row.leaderNote !== "" && row.leaderNote !== null ? (
                      <p className="mt-0.5 max-w-xs text-[10.5px] text-muted-foreground">{row.leaderNote}</p>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Button asChild variant="ghost" size="sm" className="h-7 gap-1 text-xs">
                      <Link href={`/dashboard/experiments/${row.id}`}>
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

      {wizardOpen ? (
        <ExperimentWizard
          projects={projects}
          onClose={() => setWizardOpen(false)}
          onCreated={(experimentId) => {
            // Close first: navigating with the dialog mounted leaves the page
            // behind an open overlay.
            setWizardOpen(false);
            router.push(`/dashboard/experiments/${experimentId}`);
          }}
        />
      ) : null}
    </div>
  );
}
