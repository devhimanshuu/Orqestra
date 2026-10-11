"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, FlaskConical, GitCompare, Play, RefreshCw } from "lucide-react";
import { api, errorMessage } from "@/lib/api/client";
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
import { formatCost, formatRelativeTime } from "@/components/run-status";
import { ScoreBar, StatusChip, formatRate } from "./shared";

export interface BatchRowDto {
  id: string;
  label: string | null;
  status: string;
  harnessId: string;
  harnessName: string;
  harnessVersionLabel: number;
  datasetId: string;
  datasetName: string;
  datasetVersion: number;
  caseCount: number;
  completedCount: number;
  failedCount: number;
  meanScore: number | null;
  passRate: number | null;
  costUsd: number | null;
  costKind: "estimated";
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

interface BatchesResponse {
  items: BatchRowDto[];
  total: number;
  limit: number;
  offset: number;
}

function isActive(status: string): boolean {
  return status === "PENDING" || status === "RUNNING";
}

const STATUS_FILTERS = ["", "PENDING", "RUNNING", "COMPLETED", "PARTIALLY_COMPLETED", "FAILED", "CANCELLED"];

/**
 * The run lab's front door: every evaluation batch, and the form that starts a
 * new one.
 *
 * A batch is sealed at creation (harness version × dataset version × evaluator
 * revisions), so the list is history, not a live editor. Active batches poll.
 */
export function EvaluationsView({
  projects,
  initialBatches,
}: {
  projects: { id: string; name: string }[];
  initialBatches: BatchRowDto[];
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState("");
  const [startOpen, setStartOpen] = useState(false);

  const batchesQuery = useQuery({
    queryKey: ["evaluations", status],
    queryFn: () =>
      api.get<BatchesResponse>(
        `/api/evaluations?limit=50${status !== "" ? `&status=${status}` : ""}`,
      ),
    initialData: status === "" ? { items: initialBatches, total: initialBatches.length, limit: 50, offset: 0 } : undefined,
    refetchInterval: (query) =>
      (query.state.data?.items ?? []).some((row) => isActive(row.status)) ? 4_000 : false,
  });

  const rows = batchesQuery.data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            data-testid="evaluations-status-filter"
            className="h-8 rounded-md border bg-transparent px-2 text-xs shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
          >
            {STATUS_FILTERS.map((value) => (
              <option key={value} value={value}>
                {value === "" ? "All statuses" : value.replace(/_/g, " ").toLowerCase()}
              </option>
            ))}
          </select>
          {batchesQuery.isFetching ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <RefreshCw className="h-3 w-3 animate-spin" /> Refreshing…
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm" className="h-8 gap-1.5 text-xs">
            <Link href="/dashboard/evaluations/compare">
              <GitCompare className="h-3.5 w-3.5" />
              Compare
            </Link>
          </Button>
          <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={() => setStartOpen(true)} data-testid="evaluation-start">
            <Play className="h-3.5 w-3.5" />
            Run evaluation
          </Button>
        </div>
      </div>

      {batchesQuery.isError ? (
        <p className="text-xs text-destructive">{errorMessage(batchesQuery.error)}</p>
      ) : null}

      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-14 text-center">
          <FlaskConical className="h-5 w-5 text-muted-foreground" />
          <p className="text-sm font-medium">No evaluations yet</p>
          <p className="max-w-lg text-sm text-muted-foreground">
            Run a harness version against a dataset version with one or more evaluators. Every case
            produces a real agent run, and each evaluator records a score with its evidence.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border" data-testid="evaluations-table">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Evaluation</th>
                <th className="px-4 py-2 font-medium">Harness</th>
                <th className="px-4 py-2 font-medium">Dataset</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Progress</th>
                <th className="px-4 py-2 font-medium">Mean score</th>
                <th className="px-4 py-2 font-medium">Pass rate</th>
                <th className="px-4 py-2 font-medium">Cost</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b last:border-b-0 hover:bg-muted/30">
                  <td className="px-4 py-2.5">
                    <Link href={`/dashboard/evaluations/${row.id}`} className="text-sm font-medium hover:underline">
                      {row.label ?? `Evaluation #${row.id.slice(-6)}`}
                    </Link>
                    <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                      {formatRelativeTime(row.createdAt)}
                    </p>
                  </td>
                  <td className="px-4 py-2.5 text-xs">
                    {row.harnessName}
                    <span className="ml-1 font-mono text-[10.5px] text-muted-foreground">
                      v{row.harnessVersionLabel}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs">
                    {row.datasetName}
                    <span className="ml-1 font-mono text-[10.5px] text-muted-foreground">
                      v{row.datasetVersion}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusChip value={row.status} />
                    {row.failedCount > 0 ? (
                      <p className="mt-1 text-[10.5px] text-destructive">{row.failedCount} failed</p>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs">
                    {row.completedCount}/{row.caseCount}
                  </td>
                  <td className="px-4 py-2.5">
                    <ScoreBar value={row.meanScore} />
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs">{formatRate(row.passRate)}</td>
                  <td className="px-4 py-2.5 font-mono text-xs">{formatCost(row.costUsd, row.costUsd === null)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <Button asChild variant="ghost" size="sm" className="h-7 gap-1 text-xs">
                      <Link href={`/dashboard/evaluations/${row.id}`}>
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

      {startOpen ? (
        <StartEvaluationDialog
          projects={projects}
          onClose={() => setStartOpen(false)}
          onStarted={(batchId) => {
            // Close the modal first: navigating while it is mounted leaves the
            // page behind an open dialog (Radix traps focus and hides the app).
            setStartOpen(false);
            void queryClient.invalidateQueries({ queryKey: ["evaluations"] });
            router.push(`/dashboard/evaluations/${batchId}`);
          }}
        />
      ) : null}
    </div>
  );
}

interface AgentOption {
  id: string;
  name: string;
}
interface HarnessOption {
  id: string;
  name: string;
  status: string;
}
interface HarnessVersionOption {
  id: string;
  version: number;
}
interface DatasetOption {
  id: string;
  name: string;
  currentVersion: number;
}
interface DatasetVersionOption {
  id: string;
  version: number;
  caseCount: number;
}
interface EvaluatorOption {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  currentVersion: number;
  weight: number;
  description: string | null;
}

function StartEvaluationDialog({
  projects,
  onClose,
  onStarted,
}: {
  projects: { id: string; name: string }[];
  onClose: () => void;
  onStarted: (batchId: string) => void;
}) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [agentId, setAgentId] = useState("");
  const [harnessId, setHarnessId] = useState("");
  const [harnessVersionId, setHarnessVersionId] = useState("");
  const [datasetId, setDatasetId] = useState("");
  const [datasetVersionId, setDatasetVersionId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [label, setLabel] = useState("");
  const [policy, setPolicy] = useState<"REQUIRE_ALL" | "IGNORE_MISSING">("REQUIRE_ALL");
  const [threshold, setThreshold] = useState("0.75");
  const [concurrency, setConcurrency] = useState("1");

  const agentsQuery = useQuery({
    queryKey: ["agents", projectId],
    queryFn: () => api.get<{ agents: AgentOption[] }>(`/api/agents?projectId=${projectId}`),
    enabled: projectId !== "",
  });
  const harnessesQuery = useQuery({
    queryKey: ["agent-harnesses", agentId],
    queryFn: () => api.get<{ harnesses: HarnessOption[] }>(`/api/agents/${agentId}/harnesses`),
    enabled: agentId !== "",
  });
  const harnessVersionsQuery = useQuery({
    queryKey: ["harness-versions", harnessId],
    queryFn: () => api.get<{ versions: HarnessVersionOption[] }>(`/api/harnesses/${harnessId}/versions`),
    enabled: harnessId !== "",
  });
  const datasetsQuery = useQuery({
    queryKey: ["datasets", projectId],
    queryFn: () => api.get<{ datasets: DatasetOption[] }>(`/api/datasets?projectId=${projectId}`),
    enabled: projectId !== "",
  });
  const datasetVersionsQuery = useQuery({
    queryKey: ["dataset-versions", datasetId],
    queryFn: () => api.get<{ versions: DatasetVersionOption[] }>(`/api/datasets/${datasetId}/versions`),
    enabled: datasetId !== "",
  });
  const evaluatorsQuery = useQuery({
    queryKey: ["evaluators", projectId, "enabled"],
    queryFn: () =>
      api.get<{ evaluators: EvaluatorOption[] }>(
        `/api/evaluators?projectId=${projectId}&enabledOnly=true`,
      ),
    enabled: projectId !== "",
  });

  // A batch always pins a concrete version. The select starts empty ("latest"),
  // so fall back to the newest published version — derived, never a state write
  // in an effect. The same value drives the select, so what is shown is exactly
  // what will be pinned.
  const latestHarnessVersionId =
    harnessVersionId !== "" ? harnessVersionId : (harnessVersionsQuery.data?.versions[0]?.id ?? "");

  const start = useMutation({
    mutationFn: async () => {
      const parsedThreshold = threshold.trim() === "" ? null : Number(threshold);
      const parsedConcurrency = Number(concurrency);
      return api.post<{ batch: { id: string } }>("/api/evaluations", {
        agentId,
        harnessVersionId: latestHarnessVersionId,
        datasetId,
        ...(datasetVersionId !== "" ? { datasetVersionId } : {}),
        ...(label.trim() !== "" ? { label: label.trim() } : {}),
        evaluators: selected.map((evaluatorId) => ({ evaluatorId })),
        scoringPolicy: policy,
        ...(parsedThreshold !== null && Number.isFinite(parsedThreshold)
          ? { passThreshold: parsedThreshold }
          : {}),
        ...(Number.isFinite(parsedConcurrency) ? { concurrency: parsedConcurrency } : {}),
      });
    },
    onSuccess: (result) => onStarted(result.batch.id),
  });

  const selectClass =
    "h-9 w-full rounded-md border bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40";

  return (
    <Dialog open onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Run an evaluation</DialogTitle>
          <DialogDescription>
            Pick a harness version, a dataset version and the evaluators to score it. The batch
            snapshots all three before anything executes.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="eval-project">Project</Label>
              <select
                id="eval-project"
                value={projectId}
                onChange={(event) => {
                  setProjectId(event.target.value);
                  setAgentId("");
                  setHarnessId("");
                  setHarnessVersionId("");
                  setDatasetId("");
                  setDatasetVersionId("");
                  setSelected([]);
                }}
                className={selectClass}
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="eval-agent">Agent</Label>
              <select
                id="eval-agent"
                value={agentId}
                data-testid="evaluation-agent"
                onChange={(event) => {
                  setAgentId(event.target.value);
                  setHarnessId("");
                  setHarnessVersionId("");
                }}
                className={selectClass}
              >
                <option value="">Select an agent…</option>
                {(agentsQuery.data?.agents ?? []).map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="eval-harness">Harness</Label>
              <select
                id="eval-harness"
                value={harnessId}
                data-testid="evaluation-harness"
                disabled={agentId === ""}
                onChange={(event) => {
                  setHarnessId(event.target.value);
                  setHarnessVersionId("");
                }}
                className={selectClass}
              >
                <option value="">Select a harness…</option>
                {(harnessesQuery.data?.harnesses ?? []).map((harness) => (
                  <option key={harness.id} value={harness.id}>
                    {harness.name}
                    {harness.status === "ARCHIVED" ? " (archived)" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="eval-harness-version">Harness version</Label>
              <select
                id="eval-harness-version"
                value={latestHarnessVersionId}
                data-testid="evaluation-harness-version"
                disabled={harnessId === ""}
                onChange={(event) => setHarnessVersionId(event.target.value)}
                className={selectClass}
              >
                <option value="">Latest published version</option>
                {(harnessVersionsQuery.data?.versions ?? []).map((version) => (
                  <option key={version.id} value={version.id}>
                    v{version.version}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="eval-dataset">Dataset</Label>
              <select
                id="eval-dataset"
                value={datasetId}
                data-testid="evaluation-dataset"
                onChange={(event) => {
                  setDatasetId(event.target.value);
                  setDatasetVersionId("");
                }}
                className={selectClass}
              >
                <option value="">Select a dataset…</option>
                {(datasetsQuery.data?.datasets ?? []).map((dataset) => (
                  <option key={dataset.id} value={dataset.id}>
                    {dataset.name} (v{dataset.currentVersion})
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="eval-dataset-version">Dataset version</Label>
              <select
                id="eval-dataset-version"
                value={datasetVersionId}
                data-testid="evaluation-dataset-version"
                disabled={datasetId === ""}
                onChange={(event) => setDatasetVersionId(event.target.value)}
                className={selectClass}
              >
                <option value="">Latest published version</option>
                {(datasetVersionsQuery.data?.versions ?? []).map((version) => (
                  <option key={version.id} value={version.id}>
                    v{version.version} — {version.caseCount} case{version.caseCount === 1 ? "" : "s"}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-col gap-2 rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium">Evaluators</p>
              <span className="text-[11px] text-muted-foreground">
                {selected.length} selected
              </span>
            </div>
            {(evaluatorsQuery.data?.evaluators ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No enabled evaluators in this project.{" "}
                <Link href="/dashboard/evaluators" className="underline hover:text-foreground">
                  Configure one
                </Link>
                .
              </p>
            ) : (
              <div className="grid gap-1.5 sm:grid-cols-2">
                {(evaluatorsQuery.data?.evaluators ?? []).map((evaluator) => (
                  <label
                    key={evaluator.id}
                    className="flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs hover:bg-muted/30"
                  >
                    <input
                      type="checkbox"
                      checked={selected.includes(evaluator.id)}
                      data-testid={`evaluation-evaluator-${evaluator.id}`}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, evaluator.id]
                            : current.filter((id) => id !== evaluator.id),
                        )
                      }
                      className="mt-0.5 h-3.5 w-3.5 rounded border"
                    />
                    <span className="flex flex-col">
                      <span className="font-medium">{evaluator.name}</span>
                      <span className="text-[10.5px] text-muted-foreground">
                        {evaluator.kind} · v{evaluator.currentVersion}
                        {evaluator.weight > 0 ? ` · weight ${evaluator.weight}` : ""}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-4 gap-3">
            <div className="col-span-2 flex flex-col gap-1.5">
              <Label htmlFor="eval-label">Label</Label>
              <Input
                id="eval-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Baseline before prompt change"
                data-testid="evaluation-label"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="eval-policy">Scoring policy</Label>
              <select
                id="eval-policy"
                value={policy}
                onChange={(event) =>
                  setPolicy(event.target.value === "IGNORE_MISSING" ? "IGNORE_MISSING" : "REQUIRE_ALL")
                }
                className={selectClass}
              >
                <option value="REQUIRE_ALL">Require all evaluators</option>
                <option value="IGNORE_MISSING">Ignore missing scores</option>
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="eval-threshold">Pass mark</Label>
              <Input
                id="eval-threshold"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={threshold}
                onChange={(event) => setThreshold(event.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="eval-concurrency">Parallel cases (1–5)</Label>
            <Input
              id="eval-concurrency"
              type="number"
              min={1}
              max={5}
              value={concurrency}
              onChange={(event) => setConcurrency(event.target.value)}
              className="w-28"
            />
          </div>

          {start.isError ? (
            <p className="text-xs text-destructive">{errorMessage(start.error)}</p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => start.mutate()}
            disabled={
              start.isPending ||
              agentId === "" ||
              latestHarnessVersionId === "" ||
              datasetId === "" ||
              selected.length === 0
            }
            data-testid="evaluation-start-submit"
          >
            {start.isPending ? "Starting…" : "Start evaluation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
