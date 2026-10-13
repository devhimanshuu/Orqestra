"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, FlaskConical, Info, Plus, Trash2 } from "lucide-react";
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
import { formatRelativeTime } from "@/components/run-status";
import { metricLabel } from "./shared";

/**
 * The seven-step experiment wizard.
 *
 * It is a *draft* editor: nothing is written until the last step, where the
 * server re-resolves every reference and pre-flights the configuration the client
 * composed. Two exit paths, both explicit:
 *
 *   Save draft     — writes the DRAFT; the configuration can still be edited.
 *   Create & launch — seals it (immutable snapshot + sealed batches) and
 *                    dispatches the orchestration.
 *
 * The wizard never computes a metric, an estimate or a validation verdict itself:
 * every number it shows comes from the server's pre-flight response, so the
 * review step describes exactly what would be sealed.
 */

const METRIC_KEYS = [
  "evaluation_score",
  "pass_rate",
  "failure_rate",
  "median_latency_ms",
  "p95_latency_ms",
  "average_total_tokens",
  "total_tokens",
  "estimated_cost_usd",
  "tool_calls_per_case",
] as const;

type MetricKey = (typeof METRIC_KEYS)[number];

const MINIMIZING_METRICS: ReadonlySet<string> = new Set([
  "failure_rate",
  "median_latency_ms",
  "p95_latency_ms",
  "average_total_tokens",
  "total_tokens",
  "estimated_cost_usd",
  "tool_calls_per_case",
]);

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
  contentHash: string;
  createdAt: string;
  releaseNotes: string | null;
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
interface RecentBatchOption {
  id: string;
  label: string | null;
  status: string;
  harnessVersionLabel: number;
  datasetVersion: number;
  caseCount: number;
  meanScore: number | null;
  passRate: number | null;
}

interface CandidateDraft {
  key: string;
  harnessId: string;
  harnessVersionId: string;
  label: string;
  hypothesis: string;
}

interface PlanResponse {
  configuration: {
    agentName: string;
    datasetName: string;
    datasetVersion: number;
    caseCount: number;
    availableCaseCount: number;
    baseline: { label: string; harnessName: string; harnessVersion: number };
    candidates: Array<{ label: string; harnessName: string; harnessVersion: number }>;
    evaluators: Array<{ key: string; name: string; version: number }>;
  };
  volume: {
    candidateCount: number;
    caseCount: number;
    replicates: number;
    plannedExecutions: number;
    exceedsRunBudget: boolean;
    runBudget: number | null;
  };
  estimate: {
    estimatedCostUsd: number | null;
    basis: string;
    measuredBatches: number;
    measuredCases: number;
    unpriced: string[];
    latencyMedianMs: number | null;
    billedNote: "estimated";
    pricingVersion: string;
  };
  checks: Array<{ level: "ok" | "warning" | "error"; message: string }>;
  lines: { objective: string[]; constraints: string[]; notes: string[] };
  reproducibilityNotes: string[];
  valid: boolean;
  issues: Array<{ path: string; message: string }>;
}

const SELECT_CLASS =
  "h-9 w-full rounded-md border bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40";

const STEPS = [
  "Basics",
  "Baseline",
  "Candidates",
  "Dataset & evaluators",
  "Objective & constraints",
  "Execution",
  "Review & launch",
] as const;

function nullableNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function ExperimentWizard({
  projects,
  onClose,
  onCreated,
}: {
  projects: { id: string; name: string }[];
  onClose: () => void;
  onCreated: (experimentId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);

  // --- step 1: basics --------------------------------------------------------
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [agentId, setAgentId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [hypothesis, setHypothesis] = useState("");

  // --- step 2: baseline ------------------------------------------------------
  const [baselineHarnessId, setBaselineHarnessId] = useState("");
  const [baselineVersionId, setBaselineVersionId] = useState("");

  // --- step 3: candidates ----------------------------------------------------
  const [candidates, setCandidates] = useState<CandidateDraft[]>([]);
  const [candidateHarnessId, setCandidateHarnessId] = useState("");
  const [candidateVersionId, setCandidateVersionId] = useState("");

  // --- step 4: dataset & evaluators -----------------------------------------
  const [datasetId, setDatasetId] = useState("");
  const [datasetVersionId, setDatasetVersionId] = useState("");
  const [evaluatorIds, setEvaluatorIds] = useState<string[]>([]);
  const [scoringPolicy, setScoringPolicy] = useState<"REQUIRE_ALL" | "IGNORE_MISSING">("REQUIRE_ALL");
  const [passThreshold, setPassThreshold] = useState("0.75");

  // --- step 5: objective & constraints --------------------------------------
  const [primaryMetric, setPrimaryMetric] = useState<MetricKey>("evaluation_score");
  const [primaryDirection, setPrimaryDirection] = useState<"maximize" | "minimize">("maximize");
  const [secondaryMetrics, setSecondaryMetrics] = useState<MetricKey[]>([]);
  const [objectiveNotes, setObjectiveNotes] = useState("");
  const [minPassRate, setMinPassRate] = useState("");
  const [minMeanScore, setMinMeanScore] = useState("");
  const [maxMedianLatencyMs, setMaxMedianLatencyMs] = useState("");
  const [maxTotalCostUsd, setMaxTotalCostUsd] = useState("");
  const [maxTotalTokens, setMaxTotalTokens] = useState("");
  const [maxToolCallsPerCase, setMaxToolCallsPerCase] = useState("");

  // --- step 6: execution -----------------------------------------------------
  const [concurrency, setConcurrency] = useState("1");
  const [replicates, setReplicates] = useState("1");
  const [ordering, setOrdering] = useState<"interleaved" | "baseline_first" | "random">("interleaved");
  const [randomSeed, setRandomSeed] = useState("");
  const [caseLimit, setCaseLimit] = useState("");
  const [caseTags, setCaseTags] = useState("");
  const [timeoutMs, setTimeoutMs] = useState("");
  const [maxAttempts, setMaxAttempts] = useState("2");
  const [maxRuns, setMaxRuns] = useState("");
  const [maxExperimentTokens, setMaxExperimentTokens] = useState("");
  const [maxExperimentCostUsd, setMaxExperimentCostUsd] = useState("");

  // --- step 7: review --------------------------------------------------------
  const [confirmed, setConfirmed] = useState(false);

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
  const baselineVersionsQuery = useQuery({
    queryKey: ["harness-versions", baselineHarnessId],
    queryFn: () =>
      api.get<{ versions: HarnessVersionOption[] }>(`/api/harnesses/${baselineHarnessId}/versions`),
    enabled: baselineHarnessId !== "",
  });
  const candidateVersionsQuery = useQuery({
    queryKey: ["harness-versions", candidateHarnessId],
    queryFn: () =>
      api.get<{ versions: HarnessVersionOption[] }>(`/api/harnesses/${candidateHarnessId}/versions`),
    enabled: candidateHarnessId !== "",
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
      api.get<{ evaluators: EvaluatorOption[] }>(`/api/evaluators?projectId=${projectId}&enabledOnly=true`),
    enabled: projectId !== "",
  });
  // Prior evidence for the selected harness: settled batches that ran it. Shown
  // as context for choosing a baseline, never as part of the new experiment.
  const baselineHistoryQuery = useQuery({
    queryKey: ["evaluations", "harness", baselineHarnessId],
    queryFn: () =>
      api.get<{ items: RecentBatchOption[] }>(
        `/api/evaluations?harnessId=${baselineHarnessId}&limit=5`,
      ),
    enabled: baselineHarnessId !== "",
  });

  const baselineVersions = baselineVersionsQuery.data?.versions ?? [];
  const candidateVersions = candidateVersionsQuery.data?.versions ?? [];

  const body = useMemo(
    () => ({
      projectId,
      agentId,
      name: name.trim(),
      description: description.trim() === "" ? null : description.trim(),
      hypothesis: hypothesis.trim() === "" ? null : hypothesis.trim(),
      baseline: {
        harnessVersionId: baselineVersionId,
        label: "Baseline",
      },
      candidates: candidates.map((candidate, index) => ({
        harnessVersionId: candidate.harnessVersionId,
        label: candidate.label.trim() === "" ? `Candidate ${index + 1}` : candidate.label.trim(),
        hypothesis: candidate.hypothesis.trim() === "" ? null : candidate.hypothesis.trim(),
      })),
      datasetId,
      ...(datasetVersionId !== "" ? { datasetVersionId } : {}),
      evaluators: evaluatorIds.map((evaluatorId) => ({ evaluatorId })),
      scoringPolicy,
      passThreshold: nullableNumber(passThreshold),
      objective: {
        primary: { metric: primaryMetric, direction: primaryDirection },
        secondary: secondaryMetrics.map((metric) => ({
          metric,
          direction: MINIMIZING_METRICS.has(metric) ? ("minimize" as const) : ("maximize" as const),
        })),
        notes: objectiveNotes.trim() === "" ? null : objectiveNotes.trim(),
      },
      constraints: {
        maxTotalCostUsd: nullableNumber(maxTotalCostUsd),
        maxMedianLatencyMs: nullableNumber(maxMedianLatencyMs),
        minPassRate: nullableNumber(minPassRate),
        minMeanScore: nullableNumber(minMeanScore),
        maxTotalTokens: nullableNumber(maxTotalTokens),
        maxToolCallsPerCase: nullableNumber(maxToolCallsPerCase),
      },
      execution: {
        concurrency: Number(concurrency) || 1,
        ordering,
        randomSeed: nullableNumber(randomSeed),
        replicates: Number(replicates) || 1,
        caseSelection: {
          tags:
            caseTags.trim() === ""
              ? []
              : caseTags
                  .split(",")
                  .map((entry) => entry.trim())
                  .filter((entry) => entry !== ""),
          caseKeys: [],
          limit: nullableNumber(caseLimit),
        },
        timeoutMs: nullableNumber(timeoutMs),
        limits: null,
        retryPolicy: { maxAttempts: Number(maxAttempts) || 2 },
        budget: {
          maxRuns: nullableNumber(maxRuns),
          maxTotalTokens: nullableNumber(maxExperimentTokens),
          maxCostUsd: nullableNumber(maxExperimentCostUsd),
        },
      },
    }),
    [
      projectId,
      agentId,
      name,
      description,
      hypothesis,
      baselineVersionId,
      candidates,
      datasetId,
      datasetVersionId,
      evaluatorIds,
      scoringPolicy,
      passThreshold,
      primaryMetric,
      primaryDirection,
      secondaryMetrics,
      objectiveNotes,
      maxTotalCostUsd,
      maxMedianLatencyMs,
      minPassRate,
      minMeanScore,
      maxTotalTokens,
      maxToolCallsPerCase,
      concurrency,
      ordering,
      randomSeed,
      replicates,
      caseTags,
      caseLimit,
      timeoutMs,
      maxAttempts,
      maxRuns,
      maxExperimentTokens,
      maxExperimentCostUsd,
    ],
  );

  const planQuery = useQuery({
    queryKey: ["experiment-plan", body],
    queryFn: () => api.post<PlanResponse>("/api/experiments/plan", body),
    enabled: step === 6,
    retry: false,
  });

  const createDraft = useMutation({
    mutationFn: () => api.post<{ experiment: { id: string } }>("/api/experiments", body),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["experiments"] });
      onCreated(result.experiment.id);
    },
  });

  const createAndLaunch = useMutation({
    mutationFn: async () => {
      const created = await api.post<{ experiment: { id: string } }>("/api/experiments", body);
      await api.post(`/api/experiments/${created.experiment.id}/launch`, { confirm: true });
      return created.experiment.id;
    },
    onSuccess: (experimentId) => {
      void queryClient.invalidateQueries({ queryKey: ["experiments"] });
      onCreated(experimentId);
    },
  });

  const busy = createDraft.isPending || createAndLaunch.isPending;
  const mutationError = createDraft.error ?? createAndLaunch.error;

  const addCandidate = () => {
    if (candidateVersionId === "") {
      return;
    }
    setCandidates((current) => [
      ...current,
      {
        key: `${candidateVersionId}-${current.length}`,
        harnessId: candidateHarnessId,
        harnessVersionId: candidateVersionId,
        label: "",
        hypothesis: "",
      },
    ]);
    setCandidateVersionId("");
  };

  /** A step is only passable when the references it needs are actually chosen. */
  const stepComplete = (index: number): boolean => {
    switch (index) {
      case 0:
        return name.trim() !== "" && agentId !== "";
      case 1:
        return baselineVersionId !== "";
      case 2:
        return candidates.length > 0;
      case 3:
        return datasetId !== "" && evaluatorIds.length > 0;
      case 6:
        return confirmed;
      default:
        return true;
    }
  };

  return (
    <Dialog open onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New experiment</DialogTitle>
          <DialogDescription>
            Compare immutable harness versions over one dataset version. Nothing is sealed until the
            final step, and nothing executes inside this request.
          </DialogDescription>
        </DialogHeader>

        <ol className="flex flex-wrap gap-1.5 text-[11px]" data-testid="experiment-wizard-steps">
          {STEPS.map((label, index) => (
            <li key={label}>
              <button
                type="button"
                onClick={() => setStep(index)}
                className={
                  index === step
                    ? "rounded-full bg-foreground px-2.5 py-1 font-medium text-background"
                    : "rounded-full border px-2.5 py-1 text-muted-foreground hover:text-foreground"
                }
              >
                {index + 1}. {label}
              </button>
            </li>
          ))}
        </ol>

        <div className="flex flex-col gap-4">
          {step === 0 ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="exp-project">Project</Label>
                  <select
                    id="exp-project"
                    value={projectId}
                    onChange={(event) => {
                      setProjectId(event.target.value);
                      setAgentId("");
                      setBaselineHarnessId("");
                      setBaselineVersionId("");
                      setCandidateHarnessId("");
                      setCandidateVersionId("");
                      setCandidates([]);
                      setDatasetId("");
                      setDatasetVersionId("");
                      setEvaluatorIds([]);
                    }}
                    className={SELECT_CLASS}
                  >
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="exp-agent">Agent</Label>
                  <select
                    id="exp-agent"
                    data-testid="experiment-agent"
                    value={agentId}
                    onChange={(event) => {
                      setAgentId(event.target.value);
                      setBaselineHarnessId("");
                      setBaselineVersionId("");
                      setCandidateHarnessId("");
                      setCandidateVersionId("");
                      setCandidates([]);
                    }}
                    className={SELECT_CLASS}
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

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="exp-name">Experiment name</Label>
                <Input
                  id="exp-name"
                  data-testid="experiment-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Critic loop vs single-pass research"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="exp-description">Description</Label>
                <Textarea
                  id="exp-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  rows={2}
                  placeholder="What is being compared, and in what setting."
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="exp-hypothesis">Objective or hypothesis</Label>
                <Textarea
                  id="exp-hypothesis"
                  value={hypothesis}
                  onChange={(event) => setHypothesis(event.target.value)}
                  rows={3}
                  placeholder="Adding a critic-and-revision loop improves research-answer correctness without increasing median cost by more than 30%."
                />
                <p className="text-[11px] text-muted-foreground">
                  Recorded verbatim with the results. It is a statement of intent, not a metric — the
                  constraints below are what the ranking actually enforces.
                </p>
              </div>
            </>
          ) : null}

          {step === 1 ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="exp-baseline-harness">Baseline harness</Label>
                  <select
                    id="exp-baseline-harness"
                    data-testid="experiment-baseline-harness"
                    value={baselineHarnessId}
                    onChange={(event) => {
                      setBaselineHarnessId(event.target.value);
                      setBaselineVersionId("");
                    }}
                    className={SELECT_CLASS}
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
                  <Label htmlFor="exp-baseline-version">Published version</Label>
                  <select
                    id="exp-baseline-version"
                    data-testid="experiment-baseline-version"
                    value={baselineVersionId}
                    disabled={baselineHarnessId === ""}
                    onChange={(event) => setBaselineVersionId(event.target.value)}
                    className={SELECT_CLASS}
                  >
                    <option value="">Select a published version…</option>
                    {baselineVersions.map((version) => (
                      <option key={version.id} value={version.id}>
                        v{version.version} — published {formatRelativeTime(version.createdAt)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {baselineVersionId !== "" ? (
                <div className="rounded-lg border p-3 text-xs">
                  <p className="font-medium">Pinned baseline</p>
                  {(() => {
                    const selected = baselineVersions.find((version) => version.id === baselineVersionId);
                    if (selected === undefined) {
                      return null;
                    }
                    return (
                      <ul className="mt-1.5 flex flex-col gap-0.5 text-muted-foreground">
                        <li>
                          Version <span className="font-mono text-foreground">v{selected.version}</span>
                        </li>
                        <li>
                          Published{" "}
                          <span className="font-mono text-foreground">
                            {formatRelativeTime(selected.createdAt)}
                          </span>
                        </li>
                        <li>
                          Content hash{" "}
                          <span className="font-mono text-foreground">
                            {selected.contentHash.slice(0, 16)}…
                          </span>
                        </li>
                        {selected.releaseNotes !== null ? <li>Notes: {selected.releaseNotes}</li> : null}
                      </ul>
                    );
                  })()}
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    The baseline is immutable: the experiment pins this version id and its content
                    hash. Editing the harness later cannot change what this experiment means.
                  </p>
                </div>
              ) : null}

              {baselineHarnessId !== "" ? (
                <div className="rounded-lg border p-3">
                  <p className="text-xs font-medium">Previous evaluations of this harness</p>
                  {(baselineHistoryQuery.data?.items ?? []).length === 0 ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      No evaluation batches have run this harness yet. Expected scores are unknown, so
                      the pre-flight estimate will say so rather than guess.
                    </p>
                  ) : (
                    <ul className="mt-1.5 flex flex-col gap-1 text-[11px] text-muted-foreground">
                      {(baselineHistoryQuery.data?.items ?? []).map((batch) => (
                        <li key={batch.id} className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-foreground">v{batch.harnessVersionLabel}</span>
                          <span>dataset v{batch.datasetVersion}</span>
                          <span>{batch.caseCount} cases</span>
                          <span className="uppercase">{batch.status.replace(/_/g, " ").toLowerCase()}</span>
                          <span className="font-mono">
                            mean {batch.meanScore === null ? "—" : batch.meanScore.toFixed(3)}
                          </span>
                          <span className="font-mono">
                            pass {batch.passRate === null ? "—" : `${Math.round(batch.passRate * 100)}%`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </>
          ) : null}

          {step === 2 ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="exp-candidate-harness">Candidate harness</Label>
                  <select
                    id="exp-candidate-harness"
                    data-testid="experiment-candidate-harness"
                    value={candidateHarnessId}
                    onChange={(event) => {
                      setCandidateHarnessId(event.target.value);
                      setCandidateVersionId("");
                    }}
                    className={SELECT_CLASS}
                  >
                    <option value="">Select a harness…</option>
                    {(harnessesQuery.data?.harnesses ?? []).map((harness) => (
                      <option key={harness.id} value={harness.id}>
                        {harness.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="exp-candidate-version">Published version</Label>
                  <select
                    id="exp-candidate-version"
                    data-testid="experiment-candidate-version"
                    value={candidateVersionId}
                    disabled={candidateHarnessId === ""}
                    onChange={(event) => setCandidateVersionId(event.target.value)}
                    className={SELECT_CLASS}
                  >
                    <option value="">Select a published version…</option>
                    {candidateVersions.map((version) => (
                      <option key={version.id} value={version.id}>
                        v{version.version} — {version.contentHash.slice(0, 8)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 w-fit gap-1.5 text-xs"
                onClick={addCandidate}
                disabled={candidateVersionId === ""}
                data-testid="experiment-add-candidate"
              >
                <Plus className="h-3.5 w-3.5" /> Add candidate
              </Button>

              <p className="text-[11px] text-muted-foreground">
                Need a new variant? Publish a new version from the harness editor first — a candidate
                always pins an immutable published version, never a draft. The baseline is selected in
                the previous step and stays fixed.
              </p>

              {candidates.length === 0 ? (
                <p className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
                  No candidates yet. Add at least one published version to compare against the baseline.
                </p>
              ) : (
                <div className="flex flex-col gap-2" data-testid="experiment-candidates">
                  {candidates.map((candidate, index) => (
                    <div key={candidate.key} className="rounded-lg border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium">
                          Candidate {index + 1} ·{" "}
                          <span className="font-mono">
                            v
                            {(candidateVersions.find((v) => v.id === candidate.harnessVersionId)?.version ??
                              baselineVersions.find((v) => v.id === candidate.harnessVersionId)?.version ??
                              "?")}
                          </span>
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 gap-1 text-xs"
                          onClick={() =>
                            setCandidates((current) => current.filter((entry) => entry.key !== candidate.key))
                          }
                        >
                          <Trash2 className="h-3 w-3" /> Remove
                        </Button>
                      </div>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        <div className="flex flex-col gap-1">
                          <Label htmlFor={`exp-candidate-label-${candidate.key}`}>Label</Label>
                          <Input
                            id={`exp-candidate-label-${candidate.key}`}
                            value={candidate.label}
                            placeholder={`Candidate ${index + 1}`}
                            onChange={(event) =>
                              setCandidates((current) =>
                                current.map((entry) =>
                                  entry.key === candidate.key ? { ...entry, label: event.target.value } : entry,
                                ),
                              )
                            }
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <Label htmlFor={`exp-candidate-hypothesis-${candidate.key}`}>
                            Expected improvement
                          </Label>
                          <Input
                            id={`exp-candidate-hypothesis-${candidate.key}`}
                            value={candidate.hypothesis}
                            placeholder="Correctness up, cost flat"
                            onChange={(event) =>
                              setCandidates((current) =>
                                current.map((entry) =>
                                  entry.key === candidate.key
                                    ? { ...entry, hypothesis: event.target.value }
                                    : entry,
                                ),
                              )
                            }
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : null}

          {step === 3 ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="exp-dataset">Dataset</Label>
                  <select
                    id="exp-dataset"
                    data-testid="experiment-dataset"
                    value={datasetId}
                    onChange={(event) => {
                      setDatasetId(event.target.value);
                      setDatasetVersionId("");
                    }}
                    className={SELECT_CLASS}
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
                  <Label htmlFor="exp-dataset-version">Dataset version</Label>
                  <select
                    id="exp-dataset-version"
                    data-testid="experiment-dataset-version"
                    value={datasetVersionId}
                    disabled={datasetId === ""}
                    onChange={(event) => setDatasetVersionId(event.target.value)}
                    className={SELECT_CLASS}
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
                  <span className="text-[11px] text-muted-foreground">{evaluatorIds.length} selected</span>
                </div>
                {(evaluatorsQuery.data?.evaluators ?? []).length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No enabled evaluators in this project. Configure one under Evaluators first.
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
                          checked={evaluatorIds.includes(evaluator.id)}
                          data-testid={`experiment-evaluator-${evaluator.id}`}
                          onChange={(event) =>
                            setEvaluatorIds((current) =>
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
                            {evaluator.kind} · v{evaluator.currentVersion} · weight {evaluator.weight}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="exp-policy">Scoring policy</Label>
                  <select
                    id="exp-policy"
                    value={scoringPolicy}
                    onChange={(event) =>
                      setScoringPolicy(event.target.value === "IGNORE_MISSING" ? "IGNORE_MISSING" : "REQUIRE_ALL")
                    }
                    className={SELECT_CLASS}
                  >
                    <option value="REQUIRE_ALL">Require all evaluators (missing = incomplete)</option>
                    <option value="IGNORE_MISSING">Ignore missing scores</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="exp-threshold">Pass mark (0–1)</Label>
                  <Input
                    id="exp-threshold"
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={passThreshold}
                    onChange={(event) => setPassThreshold(event.target.value)}
                    className="w-28"
                  />
                </div>
              </div>

              <p className="text-[11px] text-muted-foreground">
                Evaluators are pinned to their current revisions at launch, and every candidate is
                scored by the same ones with the same configuration — that is what makes the comparison
                a comparison.
              </p>
            </>
          ) : null}

          {step === 4 ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="exp-primary">Primary metric</Label>
                  <select
                    id="exp-primary"
                    data-testid="experiment-primary-metric"
                    value={primaryMetric}
                    onChange={(event) => {
                      const metric = event.target.value as MetricKey;
                      setPrimaryMetric(metric);
                      setPrimaryDirection(MINIMIZING_METRICS.has(metric) ? "minimize" : "maximize");
                    }}
                    className={SELECT_CLASS}
                  >
                    {METRIC_KEYS.map((metric) => (
                      <option key={metric} value={metric}>
                        {metricLabel(metric)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="exp-primary-direction">Optimization direction</Label>
                  <select
                    id="exp-primary-direction"
                    value={primaryDirection}
                    onChange={(event) =>
                      setPrimaryDirection(event.target.value === "minimize" ? "minimize" : "maximize")
                    }
                    className={SELECT_CLASS}
                  >
                    <option value="maximize">Maximize (higher is better)</option>
                    <option value="minimize">Minimize (lower is better)</option>
                  </select>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label>Secondary metrics</Label>
                <div className="flex flex-wrap gap-1.5">
                  {METRIC_KEYS.filter((metric) => metric !== primaryMetric).map((metric) => {
                    const active = secondaryMetrics.includes(metric);
                    return (
                      <button
                        key={metric}
                        type="button"
                        onClick={() =>
                          setSecondaryMetrics((current) =>
                            active ? current.filter((entry) => entry !== metric) : [...current, metric],
                          )
                        }
                        className={
                          active
                            ? "rounded-full border border-foreground/40 bg-muted px-2.5 py-1 text-[11px]"
                            : "rounded-full border px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground"
                        }
                      >
                        {metricLabel(metric)}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Secondary metrics break ties between candidates, in the order you select them, and are
                  reported alongside the primary metric. They never override it silently.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="exp-objective-notes">Notes shown with the result</Label>
                <Input
                  id="exp-objective-notes"
                  value={objectiveNotes}
                  onChange={(event) => setObjectiveNotes(event.target.value)}
                  placeholder="Correctness first; cost is a guardrail."
                />
              </div>

              <div className="flex flex-col gap-2 rounded-lg border p-3">
                <p className="text-xs font-medium">Constraints (hard limits)</p>
                <p className="text-[11px] text-muted-foreground">
                  A candidate that violates a configured limit is ineligible to win, however good its
                  primary metric is. Leave a field empty for no constraint; a limit that cannot be
                  measured yet blocks a win instead of passing silently.
                </p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="exp-min-pass">Minimum pass rate (0–1)</Label>
                    <Input
                      id="exp-min-pass"
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={minPassRate}
                      onChange={(event) => setMinPassRate(event.target.value)}
                      placeholder="e.g. 0.8"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="exp-min-score">Minimum mean score (0–1)</Label>
                    <Input
                      id="exp-min-score"
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={minMeanScore}
                      onChange={(event) => setMinMeanScore(event.target.value)}
                      placeholder="e.g. 0.7"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="exp-max-latency">Maximum median latency (ms)</Label>
                    <Input
                      id="exp-max-latency"
                      type="number"
                      min={1}
                      value={maxMedianLatencyMs}
                      onChange={(event) => setMaxMedianLatencyMs(event.target.value)}
                      placeholder="e.g. 8000"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="exp-max-cost">Maximum estimated cost (USD)</Label>
                    <Input
                      id="exp-max-cost"
                      type="number"
                      min={0}
                      step={0.01}
                      value={maxTotalCostUsd}
                      onChange={(event) => setMaxTotalCostUsd(event.target.value)}
                      placeholder="e.g. 5"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="exp-max-tokens">Maximum total tokens</Label>
                    <Input
                      id="exp-max-tokens"
                      type="number"
                      min={1}
                      value={maxTotalTokens}
                      onChange={(event) => setMaxTotalTokens(event.target.value)}
                      placeholder="e.g. 250000"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="exp-max-tools">Max tool calls per case</Label>
                    <Input
                      id="exp-max-tools"
                      type="number"
                      min={0}
                      value={maxToolCallsPerCase}
                      onChange={(event) => setMaxToolCallsPerCase(event.target.value)}
                      placeholder="e.g. 12"
                    />
                  </div>
                </div>
              </div>
            </>
          ) : null}

          {step === 5 ? (
            <>
              <div className="grid grid-cols-3 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="exp-concurrency">Parallel executions (1–5)</Label>
                  <Input
                    id="exp-concurrency"
                    type="number"
                    min={1}
                    max={5}
                    value={concurrency}
                    onChange={(event) => setConcurrency(event.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="exp-replicates">Replicates per case (1–5)</Label>
                  <Input
                    id="exp-replicates"
                    type="number"
                    min={1}
                    max={5}
                    value={replicates}
                    onChange={(event) => setReplicates(event.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="exp-ordering">Execution ordering</Label>
                  <select
                    id="exp-ordering"
                    value={ordering}
                    onChange={(event) =>
                      setOrdering(event.target.value as "interleaved" | "baseline_first" | "random")
                    }
                    className={SELECT_CLASS}
                  >
                    <option value="interleaved">Interleaved (round-robin across candidates)</option>
                    <option value="baseline_first">Baseline first</option>
                    <option value="random">Random (seeded)</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="exp-seed">Random seed (optional)</Label>
                  <Input
                    id="exp-seed"
                    type="number"
                    min={0}
                    value={randomSeed}
                    onChange={(event) => setRandomSeed(event.target.value)}
                    placeholder="Recorded for reproducibility"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="exp-case-limit">Max cases</Label>
                  <Input
                    id="exp-case-limit"
                    type="number"
                    min={1}
                    value={caseLimit}
                    onChange={(event) => setCaseLimit(event.target.value)}
                    placeholder="All selected cases"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="exp-case-tags">Only cases tagged (comma separated)</Label>
                  <Input
                    id="exp-case-tags"
                    value={caseTags}
                    onChange={(event) => setCaseTags(event.target.value)}
                    placeholder="hard, regression"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="exp-timeout">Per-case timeout (ms)</Label>
                  <Input
                    id="exp-timeout"
                    type="number"
                    min={1000}
                    value={timeoutMs}
                    onChange={(event) => setTimeoutMs(event.target.value)}
                    placeholder="Runtime default"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="exp-attempts">Attempts per case (1–3)</Label>
                  <Input
                    id="exp-attempts"
                    type="number"
                    min={1}
                    max={3}
                    value={maxAttempts}
                    onChange={(event) => setMaxAttempts(event.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="exp-max-runs">Maximum executions</Label>
                  <Input
                    id="exp-max-runs"
                    type="number"
                    min={1}
                    value={maxRuns}
                    onChange={(event) => setMaxRuns(event.target.value)}
                    placeholder="No limit"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="exp-budget-tokens">Experiment token budget</Label>
                  <Input
                    id="exp-budget-tokens"
                    type="number"
                    min={1}
                    value={maxExperimentTokens}
                    onChange={(event) => setMaxExperimentTokens(event.target.value)}
                    placeholder="Enforced against reported usage"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="exp-budget-cost">Experiment cost budget (USD)</Label>
                  <Input
                    id="exp-budget-cost"
                    type="number"
                    min={0}
                    step={0.01}
                    value={maxExperimentCostUsd}
                    onChange={(event) => setMaxExperimentCostUsd(event.target.value)}
                    placeholder="Enforced against measured usage"
                  />
                </div>
              </div>

              <div className="rounded-lg border bg-muted/30 p-3 text-[11px] text-muted-foreground">
                <p className="font-medium text-foreground">What these budgets actually guarantee</p>
                <p className="mt-1">
                  A budget stops <span className="font-medium">new</span> executions; it never discards
                  finished ones, and the experiment settles as partially completed with the reason
                  recorded. Token and cost budgets are checked against measured usage, so a single
                  execution can overshoot the ceiling before its usage is known.
                </p>
              </div>
            </>
          ) : null}

          {step === 6 ? (
            <>
              {planQuery.isPending ? (
                <p className="text-xs text-muted-foreground">Pre-flighting the configuration…</p>
              ) : null}
              {planQuery.isError ? (
                <p className="text-xs text-destructive">{errorMessageWithIssues(planQuery.error)}</p>
              ) : null}

              {planQuery.data !== undefined ? (
                <div className="flex flex-col gap-3">
                  <div className="rounded-lg border p-3">
                    <p className="text-xs font-medium">Pre-flight summary</p>
                    <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-muted-foreground sm:grid-cols-3">
                      <span>
                        Agent: <span className="text-foreground">{planQuery.data.configuration.agentName}</span>
                      </span>
                      <span>
                        Baseline:{" "}
                        <span className="text-foreground">
                          {planQuery.data.configuration.baseline.harnessName} v
                          {planQuery.data.configuration.baseline.harnessVersion}
                        </span>
                      </span>
                      <span>
                        Candidates:{" "}
                        <span className="text-foreground">{planQuery.data.configuration.candidates.length}</span>
                      </span>
                      <span>
                        Dataset:{" "}
                        <span className="text-foreground">
                          {planQuery.data.configuration.datasetName} v
                          {planQuery.data.configuration.datasetVersion}
                        </span>
                      </span>
                      <span>
                        Cases:{" "}
                        <span className="text-foreground">
                          {planQuery.data.configuration.caseCount} of{" "}
                          {planQuery.data.configuration.availableCaseCount}
                        </span>
                      </span>
                      <span>
                        Executions:{" "}
                        <span className="text-foreground">{planQuery.data.volume.plannedExecutions}</span> (
                        {planQuery.data.volume.candidateCount} candidates ×{" "}
                        {planQuery.data.volume.caseCount} cases ×{" "}
                        {planQuery.data.volume.replicates} replicate
                        {planQuery.data.volume.replicates === 1 ? "" : "s"})
                      </span>
                    </div>
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      Estimated cost:{" "}
                      <span className="font-mono text-foreground">
                        {planQuery.data.estimate.estimatedCostUsd === null
                          ? "not estimable"
                          : `~$${planQuery.data.estimate.estimatedCostUsd.toFixed(4)}`}
                      </span>{" "}
                      <span className="uppercase">(estimate)</span> — {planQuery.data.estimate.basis}
                    </p>
                    {planQuery.data.volume.exceedsRunBudget ? (
                      <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
                        Run budget ({planQuery.data.volume.runBudget}) is below this plan — the
                        experiment will stop early and settle as partially completed.
                      </p>
                    ) : null}
                  </div>

                  <ul className="flex flex-col gap-1.5 text-[11px]" data-testid="experiment-plan-checks">
                    {planQuery.data.checks.map((check) => (
                      <li key={check.message} className="flex items-start gap-1.5">
                        {check.level === "ok" ? (
                          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 text-emerald-600" />
                        ) : check.level === "warning" ? (
                          <Info className="mt-0.5 h-3.5 w-3.5 text-amber-600" />
                        ) : (
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 text-destructive" />
                        )}
                        <span className={check.level === "error" ? "text-destructive" : undefined}>
                          {check.message}
                        </span>
                      </li>
                    ))}
                  </ul>

                  {planQuery.data.lines.objective.length > 0 || planQuery.data.lines.constraints.length > 0 ? (
                    <div className="rounded-lg border p-3 text-[11px]">
                      <p className="font-medium">Objectives and constraints as they will be enforced</p>
                      <ul className="mt-1.5 flex flex-col gap-0.5 text-muted-foreground">
                        {planQuery.data.lines.objective.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                        {planQuery.data.lines.constraints.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {planQuery.data.reproducibilityNotes.length > 0 ? (
                    <div className="rounded-lg border p-3 text-[11px]">
                      <p className="font-medium">Reproducibility notes</p>
                      <ul className="mt-1.5 flex list-disc flex-col gap-0.5 pl-4 text-muted-foreground">
                        {planQuery.data.reproducibilityNotes.map((note) => (
                          <li key={note}>{note}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  <label className="flex items-start gap-2 rounded-lg border p-3 text-[11px]">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(event) => setConfirmed(event.target.checked)}
                      data-testid="experiment-confirm"
                      className="mt-0.5 h-3.5 w-3.5 rounded border"
                    />
                    <span>
                      I understand this will execute {planQuery.data.volume.plannedExecutions} case
                      executions across {planQuery.data.volume.candidateCount} candidates
                      {planQuery.data.estimate.estimatedCostUsd === null
                        ? ", and that no cost estimate is available for it"
                        : `, at an estimated cost of ~$${planQuery.data.estimate.estimatedCostUsd.toFixed(4)} (estimate only)`}
                      . Launching seals the configuration: the baselines, candidates, dataset version
                      and evaluator revisions cannot be changed afterwards.
                    </span>
                  </label>
                </div>
              ) : null}
            </>
          ) : null}

          {mutationError !== null && mutationError !== undefined ? (
            <p className="text-xs text-destructive">{errorMessageWithIssues(mutationError)}</p>
          ) : null}
        </div>

        <DialogFooter className="flex-wrap justify-between gap-2">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              className="text-xs"
              disabled={busy}
            >
              Cancel
            </Button>
            {step > 0 ? (
              <Button type="button" variant="outline" className="text-xs" onClick={() => setStep(step - 1)} disabled={busy}>
                Back
              </Button>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            {step < 6 ? (
              <Button
                type="button"
                onClick={() => setStep(step + 1)}
                disabled={!stepComplete(step)}
                data-testid="experiment-wizard-next"
              >
                Next
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  className="gap-1.5 text-xs"
                  onClick={() => createDraft.mutate()}
                  disabled={busy || !planQuery.data?.valid}
                  data-testid="experiment-save-draft"
                >
                  <FlaskConical className="h-3.5 w-3.5" />
                  {createDraft.isPending ? "Saving…" : "Save draft"}
                </Button>
                <Button
                  type="button"
                  className="gap-1.5"
                  onClick={() => createAndLaunch.mutate()}
                  disabled={busy || !confirmed || planQuery.data?.valid !== true}
                  data-testid="experiment-create-launch"
                >
                  {createAndLaunch.isPending ? "Launching…" : "Create & launch"}
                </Button>
              </>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
