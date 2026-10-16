"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, GitBranch, Plus, RefreshCw, Wand2 } from "lucide-react";
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
import { OptimizationStatusChip, StopReasonNote } from "./shared";

export interface OptimizationRowDto {
  id: string;
  name: string;
  status: string;
  agentName: string;
  baselineVersion: number;
  strategy: string;
  datasetName: string;
  caseCount: number;
  candidateCount: number;
  acceptedCount: number;
  currentIteration: number;
  maxIterations: number;
  bestCandidateLabel: string | null;
  stopReason: string | null;
  runCount: number;
  estimatedCostUsd: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

interface OptimizationsResponse {
  items: OptimizationRowDto[];
  total: number;
  limit: number;
  offset: number;
}

const STATUS_FILTERS = [
  "",
  "DRAFT",
  "QUEUED",
  "RUNNING",
  "WAITING_FOR_REVIEW",
  "COMPLETED",
  "PARTIALLY_COMPLETED",
  "FAILED",
  "CANCELLED",
];

function isActive(status: string): boolean {
  return status === "QUEUED" || status === "RUNNING" || status === "WAITING_FOR_REVIEW";
}

/**
 * The optimization list.
 *
 * Every row states the outcome, not just the status: which candidate the ranking
 * recommends and why the loop stopped — the two facts a developer needs before
 * opening a session.
 */
export function OptimizationsView({
  projects,
  initialOptimizations,
}: {
  projects: { id: string; name: string }[];
  initialOptimizations: OptimizationRowDto[];
}) {
  const router = useRouter();
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [wizardOpen, setWizardOpen] = useState(false);

  const query = useQuery({
    queryKey: ["optimizations", status, search],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "50" });
      if (status !== "") {
        params.set("status", status);
      }
      if (search.trim() !== "") {
        params.set("q", search.trim());
      }
      return api.get<OptimizationsResponse>(`/api/optimizations?${params.toString()}`);
    },
    initialData:
      status === "" && search.trim() === ""
        ? {
            items: initialOptimizations,
            total: initialOptimizations.length,
            limit: 50,
            offset: 0,
          }
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
            placeholder="Search optimizations…"
            className="h-8 w-56 text-xs"
            data-testid="optimizations-search"
          />
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            data-testid="optimizations-status-filter"
            className="h-8 rounded-md border bg-transparent px-2 text-xs shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
          >
            {STATUS_FILTERS.map((value) => (
              <option key={value} value={value}>
                {value === "" ? "All statuses" : value.replace(/_/g, " ").toLowerCase()}
              </option>
            ))}
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
          data-testid="optimization-new"
        >
          <Plus className="h-3.5 w-3.5" />
          New optimization
        </Button>
      </div>

      {query.isError ? <p className="text-xs text-destructive">{errorMessage(query.error)}</p> : null}

      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-14 text-center">
          <GitBranch className="h-5 w-5 text-muted-foreground" />
          <p className="text-sm font-medium">No optimization sessions yet</p>
          <p className="max-w-xl text-sm text-muted-foreground">
            An optimization session reads a completed evaluation, names the weaknesses it proves,
            proposes the smallest change that would address each one, and measures every candidate
            against the same baseline — never touching a published harness version.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border" data-testid="optimizations-table">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Session</th>
                <th className="px-4 py-2 font-medium">Agent</th>
                <th className="px-4 py-2 font-medium">Baseline</th>
                <th className="px-4 py-2 font-medium">Evidence</th>
                <th className="px-4 py-2 font-medium">Iteration</th>
                <th className="px-4 py-2 font-medium">Candidates</th>
                <th className="px-4 py-2 font-medium">Runs</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Recommended</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b last:border-b-0 hover:bg-muted/30">
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/dashboard/optimizations/${row.id}`}
                      className="text-sm font-medium hover:underline"
                    >
                      {row.name}
                    </Link>
                    <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                      {row.strategy.toLowerCase().replace("_", "-")} ·{" "}
                      {formatRelativeTime(row.createdAt)}
                    </p>
                  </td>
                  <td className="px-4 py-2.5 text-xs">{row.agentName}</td>
                  <td className="px-4 py-2.5 text-xs font-mono">
                    {row.baselineVersion === 0 ? "—" : `v${row.baselineVersion}`}
                  </td>
                  <td className="px-4 py-2.5 text-xs">
                    {row.datasetName}
                    <span className="ml-1 font-mono text-[10.5px] text-muted-foreground">
                      {row.caseCount} case{row.caseCount === 1 ? "" : "s"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs font-mono tabular-nums">
                    {row.currentIteration}/{row.maxIterations}
                  </td>
                  <td className="px-4 py-2.5 text-xs font-mono tabular-nums">
                    {row.candidateCount}
                    {row.acceptedCount > 0 ? (
                      <span className="ml-1 text-emerald-600 dark:text-emerald-400">
                        ({row.acceptedCount} accepted)
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5 text-xs font-mono tabular-nums">{row.runCount}</td>
                  <td className="px-4 py-2.5">
                    <OptimizationStatusChip value={row.status} />
                    {row.stopReason !== null && !isActive(row.status) ? (
                      <div className="mt-1 max-w-[180px]">
                        <StopReasonNote reason={row.stopReason} />
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5 text-xs">
                    {row.bestCandidateLabel !== null ? (
                      <span className="font-medium">{row.bestCandidateLabel}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Button asChild variant="ghost" size="sm" className="h-7 gap-1 text-xs">
                      <Link href={`/dashboard/optimizations/${row.id}`}>
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

      <OptimizationWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        projects={projects}
        onCreated={(sessionId) => {
          setWizardOpen(false);
          router.push(`/dashboard/optimizations/${sessionId}`);
        }}
      />
    </div>
  );
}

// ------------------------------------------------------------------------------
// Creation
// ------------------------------------------------------------------------------

interface AgentOption {
  id: string;
  name: string;
}
interface HarnessOption {
  id: string;
  name: string;
  currentVersion?: number;
}
interface VersionOption {
  id: string;
  version: number;
  name: string;
}
interface BatchOption {
  id: string;
  label: string | null;
  status: string;
  harnessId: string;
  harnessVersionLabel: number;
  caseCount: number;
  passRate: number | null;
  meanScore: number | null;
}
interface PlanResponse {
  valid: boolean;
  checks: Array<{ level: "ok" | "warning" | "error"; message: string }>;
  lines: { objective: string[]; constraints: string[]; notes: string[] };
  volume: { caseCount: number; maxCandidates: number; runsPerCandidate: number; maxRuns: number };
}

/**
 * The creation dialog.
 *
 * References are chained (project → agent → harness → baseline version ← evidence
 * batch) and the baseline version is *derived from the batch*, because a
 * comparison against another version's numbers is meaningless — the server
 * refuses that case anyway, and the plan endpoint reports it before anything is
 * written.
 */
function OptimizationWizard({
  open,
  onOpenChange,
  projects,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: { id: string; name: string }[];
  onCreated: (sessionId: string) => void;
}) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [agentId, setAgentId] = useState("");
  const [harnessId, setHarnessId] = useState("");
  const [batchId, setBatchId] = useState("");
  const [name, setName] = useState("");
  const [maxIterations, setMaxIterations] = useState(3);
  const [maxRuns, setMaxRuns] = useState(60);
  const [requireReview, setRequireReview] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agentsQuery = useQuery({
    queryKey: ["optimization-agents", projectId],
    queryFn: () => api.get<{ agents: AgentOption[] }>(`/api/agents?projectId=${projectId}`),
    enabled: open && projectId !== "",
  });
  const harnessesQuery = useQuery({
    queryKey: ["optimization-harnesses", agentId],
    queryFn: () => api.get<{ harnesses: HarnessOption[] }>(`/api/agents/${agentId}/harnesses`),
    enabled: open && agentId !== "",
  });
  const versionsQuery = useQuery({
    queryKey: ["optimization-versions", harnessId],
    queryFn: () => api.get<{ versions: VersionOption[] }>(`/api/harnesses/${harnessId}/versions`),
    enabled: open && harnessId !== "",
  });
  const batchesQuery = useQuery({
    queryKey: ["optimization-batches", projectId],
    queryFn: () =>
      api.get<{ items: BatchOption[]; total: number }>(
        `/api/evaluations?projectId=${projectId}&limit=100`,
      ),
    enabled: open && projectId !== "",
  });

  const agents = agentsQuery.data?.agents ?? [];
  const harnesses = harnessesQuery.data?.harnesses ?? [];
  const versions = versionsQuery.data?.versions ?? [];
  const batches = (batchesQuery.data?.items ?? []).filter(
    (batch) => batch.harnessId === harnessId && batch.status === "COMPLETED",
  );
  const selectedBatch = batches.find((batch) => batch.id === batchId) ?? null;
  const baselineVersion =
    selectedBatch === null
      ? null
      : (versions.find((version) => version.version === selectedBatch.harnessVersionLabel) ?? null);

  const body =
    name.trim() !== "" &&
    agentId !== "" &&
    harnessId !== "" &&
    baselineVersion !== null &&
    selectedBatch !== null
      ? {
          projectId,
          agentId,
          name: name.trim(),
          baselineVersionId: baselineVersion.id,
          sourceBatchId: selectedBatch.id,
          strategy: "RULE_BASED" as const,
          limits: { maxIterations, maxRuns, requireApprovalBeforeEvaluation: requireReview },
          requireApproval: true,
        }
      : null;

  const planQuery = useQuery({
    queryKey: ["optimization-plan", body],
    queryFn: () => api.post<PlanResponse>("/api/optimizations/plan", body),
    enabled: open && body !== null,
  });

  const canSubmit = !submitting && body !== null && planQuery.data?.valid === true;

  async function submit(): Promise<void> {
    if (body === null) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const created = await api.post<{ session: { id: string } }>("/api/optimizations", body);
      await api.post(`/api/optimizations/${created.session.id}/start`, { confirm: true });
      onCreated(created.session.id);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  const fieldClass =
    "h-8 w-full rounded-md border bg-transparent px-2 text-xs shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-sm font-medium">New optimization session</DialogTitle>
          <DialogDescription className="text-xs">
            Pick the harness, then the completed evaluation whose failures seed the analysis. The
            baseline version is derived from that batch, and the configuration is sealed when the
            session starts.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Project</span>
            <select
              className={fieldClass}
              value={projectId}
              onChange={(event) => {
                setProjectId(event.target.value);
                setAgentId("");
                setHarnessId("");
                setBatchId("");
              }}
              data-testid="optimization-project"
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Agent</span>
            <select
              className={fieldClass}
              value={agentId}
              onChange={(event) => {
                setAgentId(event.target.value);
                setHarnessId("");
                setBatchId("");
              }}
              data-testid="optimization-agent"
            >
              <option value="">Choose an agent…</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Harness</span>
            <select
              className={fieldClass}
              value={harnessId}
              onChange={(event) => {
                setHarnessId(event.target.value);
                setBatchId("");
              }}
              data-testid="optimization-harness"
            >
              <option value="">Choose a harness…</option>
              {harnesses.map((harness) => (
                <option key={harness.id} value={harness.id}>
                  {harness.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Evidence (completed evaluation)</span>
            <select
              className={fieldClass}
              value={batchId}
              onChange={(event) => setBatchId(event.target.value)}
              data-testid="optimization-source-batch"
            >
              <option value="">Choose an evaluation…</option>
              {batches.map((batch) => (
                <option key={batch.id} value={batch.id}>
                  {batch.label ?? batch.id.slice(-6)} · v{batch.harnessVersionLabel} ·{" "}
                  {batch.caseCount} case{batch.caseCount === 1 ? "" : "s"}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs sm:col-span-2">
            <span className="text-muted-foreground">Session name</span>
            <Input
              className="h-8 text-xs"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Close the compliance gap on the research agent"
              data-testid="optimization-name"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Iteration limit (≤ 10)</span>
            <Input
              className="h-8 text-xs"
              type="number"
              min={1}
              max={10}
              value={maxIterations}
              onChange={(event) => setMaxIterations(Math.max(1, Number(event.target.value) || 1))}
              data-testid="optimization-iterations"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Run budget</span>
            <Input
              className="h-8 text-xs"
              type="number"
              min={1}
              value={maxRuns}
              onChange={(event) => setMaxRuns(Math.max(1, Number(event.target.value) || 1))}
              data-testid="optimization-runs"
            />
          </label>

          <label className="flex items-center gap-2 text-xs sm:col-span-2">
            <input
              type="checkbox"
              checked={requireReview}
              onChange={(event) => setRequireReview(event.target.checked)}
              data-testid="optimization-require-review"
            />
            <span>
              Park every candidate for my approval before it is evaluated
              <span className="ml-1 text-muted-foreground">
                (the loop stops and waits; you approve or reject, then it continues)
              </span>
            </span>
          </label>
        </div>

        <div className="rounded-md border bg-muted/30 p-3 text-xs">
          <p className="mb-1.5 flex items-center gap-1.5 font-medium">
            <Wand2 className="h-3.5 w-3.5" />
            Pre-flight
          </p>
          {body === null ? (
            <p className="text-muted-foreground">
              Choose a project, agent, harness and completed evaluation to see what would be sealed.
            </p>
          ) : planQuery.isFetching ? (
            <p className="text-muted-foreground">Checking references…</p>
          ) : planQuery.isError ? (
            <p className="text-destructive">{errorMessage(planQuery.error)}</p>
          ) : planQuery.data === undefined ? null : (
            <div className="flex flex-col gap-1">
              {(planQuery.data.checks ?? []).map((check, index) => (
                <p
                  key={`${check.level}-${index}`}
                  className={
                    check.level === "error"
                      ? "text-destructive"
                      : check.level === "warning"
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-emerald-600 dark:text-emerald-400"
                  }
                >
                  {check.message}
                </p>
              ))}
              <p className="text-muted-foreground">
                Baseline: v{baselineVersion?.version ?? "—"} · {planQuery.data.volume.caseCount}{" "}
                case(s) · up to {planQuery.data.volume.maxCandidates} candidate(s) ·{" "}
                {planQuery.data.volume.maxRuns} run budget
              </p>
              {planQuery.data.lines.objective.map((line) => (
                <p key={line} className="text-muted-foreground">
                  {line}
                </p>
              ))}
            </div>
          )}
        </div>

        {error !== null ? <p className="text-xs text-destructive">{error}</p> : null}

        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-8 text-xs"
            disabled={!canSubmit}
            onClick={() => void submit()}
            data-testid="optimization-create"
          >
            {submitting ? "Creating…" : "Create and start"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
