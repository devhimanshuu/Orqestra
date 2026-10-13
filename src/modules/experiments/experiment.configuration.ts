/**
 * Configuration resolution and pre-flight planning.
 *
 * Everything a launch needs is resolved *here* and nowhere else: the agent, the
 * baseline and candidate harness versions (each compiled, so an unexecutable
 * graph is refused before anything is sealed), the dataset version, the selected
 * cases, the evaluator revisions, the objective, the constraints and the
 * execution settings.
 *
 * Two rules shape the result:
 *
 *  - **Resolution never guesses.** A version id that does not exist, a harness
 *    that belongs to another agent, a dataset from another project, an evaluator
 *    the caller cannot see: each is reported as an issue with a path, and the
 *    launch refuses the whole configuration rather than running "the closest
 *    thing it could find".
 *  - **A pre-flight is a plan, not a promise.** The volume is exact (cases ×
 *    candidates × replicates, clamped by the run budget) while cost and latency
 *    are *estimates* derived from comparable measured batches, and they say so —
 *    including when they cannot be estimated at all, which never blocks a launch.
 */

import type { AuthUser } from "@/lib/auth/provider";
import { NotFoundError } from "@/lib/errors";
import { assertAgentAccess, assertDatasetAccess, assertHarnessAccess } from "@/modules/access/access.service";
import { datasetRepository } from "@/modules/evaluation/dataset.repository";
import type { Dataset, DatasetCaseSnapshot } from "@/modules/evaluation/dataset.types";
import { DEFAULT_SCORING_POLICY } from "@/modules/evaluation/scoring";
import type { EvaluatorAssignmentSnapshot } from "@/modules/evaluation/batch.types";
import type { ScoringPolicy } from "@/modules/evaluation/evaluation.types";
import { resolveAssignments } from "@/modules/evaluation/evaluator.service";
import { compileHarness } from "@/modules/runtime/compiler";
import { RUNTIME_ENGINE_VERSION } from "@/modules/runtime/runtime";
import type { RuntimeExecutionLimits } from "@/modules/runtime/state/execution-state";
import { harnessRepository } from "@/modules/harness/harness.repository";
import type { Harness, HarnessVersion } from "@/modules/harness/harness.types";
import { BUILT_IN_PRICING_VERSION, type CostEstimate } from "@/modules/evaluation/pricing";
import { estimateUsageCost, type PricedUsage } from "@/modules/evaluation/pricing";
import { experimentRepository } from "./experiment.repository";
import {
  DEFAULT_CASE_ATTEMPTS,
  MAX_EXPERIMENT_CANDIDATES,
  MAX_EXPERIMENT_CASES,
  MAX_EXPERIMENT_CONCURRENCY,
  MAX_EXPERIMENT_REPLICATES,
} from "./experiment.inputs";
import {
  describeConstraints,
  describeObjective,
  planExecution,
  validateConstraints,
  validateObjective,
  type ObjectiveIssue,
  type PlannedExecution,
} from "./experiment.objective";
import {
  EMPTY_EXPERIMENT_CONSTRAINTS,
  type ExperimentCandidateRole,
  type ExperimentConfigSnapshot,
  type ExperimentConstraints,
  type ExperimentExecution,
  type ExperimentHarnessSnapshot,
  type ExperimentObjective,
  type ExperimentRecord,
  ExperimentValidationError,
} from "./experiment.types";

/** The editable configuration, from a request body or a stored draft. */
export interface ExperimentDraftConfig {
  name: string;
  description: string | null;
  hypothesis: string | null;
  agentId: string;
  datasetId: string;
  datasetVersionId: string | null;
  baseline: { harnessVersionId: string; label: string | null; hypothesis: string | null };
  candidates: Array<{ harnessVersionId: string; label: string | null; hypothesis: string | null }>;
  evaluators: Array<{ evaluatorId: string; weight?: number }>;
  scoringPolicy: ScoringPolicy;
  passThreshold: number | null;
  objective: ExperimentObjective | null;
  constraints: ExperimentConstraints | null;
  execution: ExperimentExecution | null;
}

export interface ResolvedCandidate {
  label: string;
  role: ExperimentCandidateRole;
  hypothesis: string | null;
  orderIndex: number;
  harness: Harness;
  harnessVersion: HarnessVersion;
  harnessSnapshot: ExperimentHarnessSnapshot;
}

export interface ExperimentCostEstimate {
  /** Null when there is no comparable measured history to derive one from. */
  estimatedCostUsd: number | null;
  /** What the number is based on — shown next to it, always. */
  basis: string;
  measuredBatches: number;
  measuredCases: number;
  unpriced: string[];
  sources: string[];
  /** Median per-case latency from comparable batches, when available. */
  latencyMedianMs: number | null;
  billedNote: "estimated";
  /** Pricing table revision used for any re-derivation. */
  pricingVersion: string;
}

export interface ResolvedConfiguration {
  agent: { id: string; name: string; projectId: string };
  dataset: Dataset;
  datasetVersion: { id: string; version: number; contentHash: string };
  availableCaseCount: number;
  selectedCases: DatasetCaseSnapshot[];
  evaluatorAssignments: EvaluatorAssignmentSnapshot[];
  objective: ExperimentObjective;
  constraints: ExperimentConstraints;
  execution: ExperimentExecution;
  candidates: ResolvedCandidate[];
  planned: PlannedExecution;
  scoringPolicy: ScoringPolicy;
  passThreshold: number | null;
  issues: ObjectiveIssue[];
  warnings: string[];
  estimate: ExperimentCostEstimate;
  reproducibilityNotes: string[];
}

const DEFAULT_OBJECTIVE: ExperimentObjective = {
  primary: { metric: "evaluation_score", direction: "maximize" },
  secondary: [],
  notes: null,
};

const DEFAULT_EXECUTION: ExperimentExecution = {
  concurrency: 1,
  ordering: "interleaved",
  randomSeed: null,
  replicates: 1,
  caseSelection: { tags: [], caseKeys: [], limit: null },
  timeoutMs: null,
  limits: null,
  retryPolicy: { maxAttempts: DEFAULT_CASE_ATTEMPTS },
  budget: { maxRuns: null, maxTotalTokens: null, maxCostUsd: null },
};

/** Applies the platform defaults to a partially specified configuration. */
export function normalizeDraftConfiguration(input: {
  objective?: ExperimentObjective | null;
  constraints?: ExperimentConstraints | null;
  execution?: Partial<ExperimentExecution> | null;
}): { objective: ExperimentObjective; constraints: ExperimentConstraints; execution: ExperimentExecution } {
  const objective = input.objective ?? DEFAULT_OBJECTIVE;
  const constraints = input.constraints ?? EMPTY_EXPERIMENT_CONSTRAINTS;
  const execution: ExperimentExecution = {
    ...DEFAULT_EXECUTION,
    ...(input.execution ?? {}),
    caseSelection: { ...DEFAULT_EXECUTION.caseSelection, ...(input.execution?.caseSelection ?? {}) },
    retryPolicy: { ...DEFAULT_EXECUTION.retryPolicy, ...(input.execution?.retryPolicy ?? {}) },
    budget: { ...DEFAULT_EXECUTION.budget, ...(input.execution?.budget ?? {}) },
  };
  return { objective, constraints, execution };
}

/** Clamps the execution settings to the platform ceilings (never trusts a client). */
export function clampExecution(execution: ExperimentExecution): ExperimentExecution {
  return {
    ...execution,
    concurrency: Math.min(Math.max(execution.concurrency, 1), MAX_EXPERIMENT_CONCURRENCY),
    replicates: Math.min(Math.max(execution.replicates, 1), MAX_EXPERIMENT_REPLICATES),
    caseSelection: {
      ...execution.caseSelection,
      limit:
        execution.caseSelection.limit === null
          ? null
          : Math.min(execution.caseSelection.limit, MAX_EXPERIMENT_CASES),
    },
  };
}

export function draftConfigFromBody(body: {
  agentId: string;
  name: string;
  description?: string | null | undefined;
  hypothesis?: string | null | undefined;
  datasetId: string;
  datasetVersionId?: string | undefined;
  baseline: { harnessVersionId: string; label?: string | undefined; hypothesis?: string | null | undefined };
  candidates: Array<{ harnessVersionId: string; label?: string | undefined; hypothesis?: string | null | undefined }>;
  evaluators: Array<{ evaluatorId: string; weight?: number | undefined }>;
  scoringPolicy?: ScoringPolicy | undefined;
  passThreshold?: number | null | undefined;
  objective?: ExperimentObjective | undefined;
  constraints?: ExperimentConstraints | undefined;
  execution?: ExperimentExecution | undefined;
}): ExperimentDraftConfig {
  return {
    name: body.name,
    description: body.description ?? null,
    hypothesis: body.hypothesis ?? null,
    agentId: body.agentId,
    datasetId: body.datasetId,
    datasetVersionId: body.datasetVersionId ?? null,
    baseline: {
      harnessVersionId: body.baseline.harnessVersionId,
      label: body.baseline.label ?? "Baseline",
      hypothesis: body.baseline.hypothesis ?? null,
    },
    candidates: body.candidates.map((candidate) => ({
      harnessVersionId: candidate.harnessVersionId,
      label: candidate.label ?? null,
      hypothesis: candidate.hypothesis ?? null,
    })),
    evaluators: body.evaluators,
    scoringPolicy: body.scoringPolicy ?? DEFAULT_SCORING_POLICY,
    passThreshold: body.passThreshold ?? null,
    objective: body.objective ?? null,
    constraints: body.constraints ?? null,
    execution: body.execution ?? null,
  };
}

/**
 * Re-reads a stored draft into the same shape, so one resolver serves both the
 * create/edit path and the pre-flight of an already-stored experiment.
 *
 * The evaluator *ids* are recovered from the stored snapshot keys
 * (`<evaluatorId>@<version>`), so a re-resolution can report that a revision
 * moved on between the draft and the launch instead of silently switching it.
 */
export function draftConfigFromRecord(
  record: ExperimentRecord,
  candidates: Array<{ harnessVersionId: string; label: string; hypothesis: string | null; role: string }>,
): ExperimentDraftConfig {
  const baseline = candidates.find((candidate) => candidate.role === "BASELINE") ?? candidates[0];
  const rest = candidates.filter((candidate) => candidate !== baseline);
  return {
    name: record.name,
    description: record.description,
    hypothesis: record.hypothesis,
    agentId: record.agentId,
    datasetId: record.datasetId,
    datasetVersionId: record.datasetVersionId,
    baseline: {
      harnessVersionId: baseline?.harnessVersionId ?? "",
      label: baseline?.label ?? "Baseline",
      hypothesis: baseline?.hypothesis ?? null,
    },
    candidates: rest.map((candidate) => ({
      harnessVersionId: candidate.harnessVersionId,
      label: candidate.label,
      hypothesis: candidate.hypothesis,
    })),
    evaluators: record.evaluatorConfig.map((assignment) => ({
      evaluatorId: assignment.evaluatorId,
      weight: assignment.weight,
    })),
    scoringPolicy: record.scoringPolicy,
    passThreshold: record.passThreshold,
    objective: record.objective,
    constraints: record.constraints,
    execution: record.execution,
  };
}

/** Selects dataset cases by tag/key filters and an optional cap. */
export function selectCases(
  cases: readonly DatasetCaseSnapshot[],
  selection: ExperimentExecution["caseSelection"],
): DatasetCaseSnapshot[] {
  const byTag = selection.tags.length === 0 ? [...cases] : cases.filter((entry) => entry.tags.some((tag) => selection.tags.includes(tag)));
  const byKey =
    selection.caseKeys.length === 0
      ? byTag
      : byTag.filter((entry) => selection.caseKeys.includes(entry.caseKey));
  if (selection.limit === null || byKey.length <= selection.limit) {
    return byKey;
  }
  return byKey.slice(0, selection.limit);
}

/**
 * Resolves a draft configuration against the database.
 *
 * Hard problems (bad ids, foreign resources, invalid graphs, an empty case
 * selection) are returned as `issues`; the caller decides whether to refuse
 * (create/launch) or to display them (a pre-flight view). Softer facts — no
 * quality floor configured, a budget below the plan — are `warnings`: they are
 * explained, never hidden, and never block. Access problems still throw, so
 * foreign ids do not leak.
 */
export async function resolveExperimentConfiguration(
  user: AuthUser,
  config: ExperimentDraftConfig,
): Promise<ResolvedConfiguration> {
  const issues: ObjectiveIssue[] = [];
  const warnings: string[] = [];

  const agent = await assertAgentAccess(user.id, config.agentId);
  const normalized = normalizeDraftConfiguration({
    objective: config.objective,
    constraints: config.constraints,
    execution: config.execution,
  });
  const objective = normalized.objective;
  const constraints = normalized.constraints;
  const execution = clampExecution(normalized.execution);

  // --- harness versions (baseline + candidates) -------------------------------
  const selections = [
    { ...config.baseline, role: "BASELINE" as const, orderIndex: 0, fallbackLabel: "Baseline" },
    ...config.candidates.map((candidate, index) => ({
      ...candidate,
      role: "CANDIDATE" as const,
      orderIndex: index + 1,
      fallbackLabel: `Candidate ${index + 1}`,
    })),
  ];

  if (config.candidates.length === 0) {
    issues.push({
      path: "candidates",
      message: "Add at least one candidate to compare against the baseline",
    });
  }

  if (selections.length > MAX_EXPERIMENT_CANDIDATES) {
    issues.push({
      path: "candidates",
      message: `An experiment compares at most ${MAX_EXPERIMENT_CANDIDATES} candidates (including the baseline).`,
    });
  }

  const resolvedCandidates: ResolvedCandidate[] = [];
  const seenVersionIds = new Set<string>();
  for (const [index, selection] of selections.entries()) {
    const path = selection.role === "BASELINE" ? "baseline.harnessVersionId" : `candidates.${index - 1}.harnessVersionId`;
    const harnessVersion = await harnessRepository.findVersionById(selection.harnessVersionId);
    if (harnessVersion === null) {
      issues.push({ path, message: `Harness version "${selection.harnessVersionId}" not found` });
      continue;
    }
    if (seenVersionIds.has(harnessVersion.id)) {
      issues.push({
        path,
        message: `Harness version v${harnessVersion.version} is already part of this experiment with another label`,
      });
      continue;
    }
    seenVersionIds.add(harnessVersion.id);

    const harness = await assertHarnessAccess(user.id, harnessVersion.harnessId);
    if (harness.agentId !== agent.id) {
      issues.push({
        path,
        message: `"${harness.name}" v${harnessVersion.version} belongs to a different agent — an experiment must keep one agent constant`,
      });
      continue;
    }

    const compiled = compileHarness(harnessVersion.definition);
    if (!compiled.ok) {
      issues.push({
        path,
        message: `"${harness.name}" v${harnessVersion.version} is not executable: ${compiled.issues
          .map((issue) => issue.message)
          .join("; ")}`,
      });
      continue;
    }

    resolvedCandidates.push({
      label: (selection.label ?? selection.fallbackLabel).trim(),
      role: selection.role,
      hypothesis: selection.hypothesis,
      orderIndex: selection.orderIndex,
      harness,
      harnessVersion,
      harnessSnapshot: {
        harnessId: harness.id,
        harnessVersionId: harnessVersion.id,
        harnessVersion: harnessVersion.version,
        harnessName: harness.name,
        contentHash: harnessVersion.contentHash,
        entryNode: compiled.plan.entryNode,
        nodeCount: compiled.plan.stats.nodeCount,
        edgeCount: compiled.plan.stats.edgeCount,
      },
    });
  }

  const labels = new Set<string>();
  for (const candidate of resolvedCandidates) {
    const normalizedLabel = candidate.label.toLowerCase();
    if (labels.has(normalizedLabel)) {
      issues.push({ path: "candidates", message: `Candidate label "${candidate.label}" is used twice` });
    }
    labels.add(normalizedLabel);
  }

  // --- dataset and case selection ---------------------------------------------
  const dataset = await assertDatasetAccess(user.id, config.datasetId);
  if (dataset.projectId !== agent.projectId) {
    issues.push({
      path: "datasetId",
      message: "The dataset and the agent belong to different projects — an experiment must stay inside one project",
    });
  }

  const datasetVersion =
    config.datasetVersionId === null
      ? await datasetRepository.findLatestVersion(dataset.id)
      : await datasetRepository.findVersionById(config.datasetVersionId);
  if (datasetVersion === null || datasetVersion.datasetId !== dataset.id) {
    throw new NotFoundError("Dataset version not found");
  }
  if (datasetVersion.cases.length === 0) {
    issues.push({
      path: "datasetVersionId",
      message: "This dataset version has no test cases — add cases and publish a version first",
    });
  }

  const selectedCases = selectCases(datasetVersion.cases, execution.caseSelection);
  if (selectedCases.length === 0) {
    issues.push({
      path: "execution.caseSelection",
      message: "The test-case selection matched no cases in this dataset version",
    });
  }

  // --- evaluators ---------------------------------------------------------------
  let evaluatorAssignments: EvaluatorAssignmentSnapshot[] = [];
  try {
    const assignments = await resolveAssignments(user, config.evaluators);
    evaluatorAssignments = assignments.map((assignment) => ({
      key: `${assignment.evaluatorId}@${assignment.evaluatorVersion}`,
      evaluatorId: assignment.evaluatorId,
      evaluatorVersion: assignment.evaluatorVersion,
      kind: assignment.kind as EvaluatorAssignmentSnapshot["kind"],
      name: assignment.name,
      weight: assignment.weight,
      config: assignment.config,
      usesLlm: assignment.kind === "llm_judge",
    }));
  } catch (error) {
    issues.push({
      path: "evaluators",
      message: error instanceof Error ? error.message : "The selected evaluators could not be resolved",
    });
  }

  // --- objective and constraints ------------------------------------------------
  issues.push(...validateObjective(objective));
  issues.push(...validateConstraints(constraints));
  if (objective.primary.direction !== (objective.primary.metric === "evaluation_score" ? "maximize" : objective.primary.direction)) {
    warnings.push(
      `The primary objective is to ${objective.primary.direction} ${objective.primary.metric.replace(/_/g, " ")} — that is allowed, but check it is the question you mean to ask.`,
    );
  }
  if (constraints.minPassRate === null && constraints.minMeanScore === null && evaluatorAssignments.length > 0) {
    warnings.push(
      "No quality floor is configured: a candidate could win on cost or latency while scoring worse. Add a minimum pass rate or mean score if that is not acceptable.",
    );
  }

  // --- volume -------------------------------------------------------------------
  const planned = planExecution({
    candidateCount: resolvedCandidates.length,
    caseCount: selectedCases.length,
    execution,
  });
  if (planned.exceedsRunBudget) {
    // A budget below the plan is a legitimate intent — "run this far, then stop"
    // — and the orchestrator honours it by settling PARTIALLY_COMPLETED with
    // whatever executed. It is explained, not refused.
    warnings.push(
      `The run budget (${planned.runBudget}) is below the planned executions (${planned.plannedExecutions}): the experiment will stop once the budget is spent and settle as partially completed, keeping the results that were already obtained.`,
    );
  }
  if (execution.randomSeed === null && execution.ordering === "random") {
    warnings.push(
      "Execution order is randomized without a recorded seed; the exact ordering will not be reproducible. Set a seed to make it repeatable.",
    );
  }
  if (execution.replicates === 1) {
    warnings.push(
      "One trial per case: with a nondeterministic model, a single execution cannot separate a real improvement from run-to-run variance. Use replicates (2 or more) when the difference is small.",
    );
  }

  // --- measured cost / latency estimate ----------------------------------------
  const estimate = await estimateCost({
    harnessVersionIds: resolvedCandidates.map((candidate) => candidate.harnessVersion.id),
    datasetVersionId: datasetVersion.id,
    plannedExecutions: planned.plannedExecutions,
  });

  const reproducibilityNotes = buildReproducibilityNotes({
    replicates: execution.replicates,
    selectedCases: selectedCases.length,
    availableCases: datasetVersion.cases.length,
    limited: !(execution.caseSelection.tags.length === 0 && execution.caseSelection.caseKeys.length === 0 && execution.caseSelection.limit === null),
    estimate,
  });

  return {
    agent: { id: agent.id, name: agent.name, projectId: agent.projectId },
    dataset,
    datasetVersion: {
      id: datasetVersion.id,
      version: datasetVersion.version,
      contentHash: datasetVersion.contentHash,
    },
    availableCaseCount: datasetVersion.cases.length,
    selectedCases,
    evaluatorAssignments,
    objective,
    constraints,
    execution,
    candidates: resolvedCandidates,
    planned,
    scoringPolicy: config.scoringPolicy,
    passThreshold: config.passThreshold,
    issues,
    warnings,
    estimate,
    reproducibilityNotes,
  };
}

/** Throws when a resolution produced hard issues (create/launch paths). */
export function assertResolved(configuration: ResolvedConfiguration): void {
  if (configuration.issues.length > 0) {
    throw new ExperimentValidationError(
      "This experiment configuration cannot be launched as configured",
      configuration.issues,
    );
  }
}

/**
 * Estimates cost and latency from comparable *measured* batches.
 *
 * Why this way: Orqestra does not simulate token counts. The only honest basis is
 * what the same harness versions actually spent against the same dataset version.
 * With no such history the estimate is `null` and says so — and a null estimate
 * never blocks a launch, it only means cost cannot be predicted.
 */
export async function estimateCost(input: {
  harnessVersionIds: readonly string[];
  datasetVersionId: string;
  plannedExecutions: number;
}): Promise<ExperimentCostEstimate> {
  const history = await experimentRepository.comparableBatchCostHistory({
    harnessVersionIds: input.harnessVersionIds,
    datasetVersionId: input.datasetVersionId,
  });

  const measuredCases = history.reduce((sum, entry) => sum + entry.caseCount, 0);
  const priced = history.filter((entry) => entry.costUsd !== null);

  if (priced.length === 0 || measuredCases === 0) {
    return {
      estimatedCostUsd: null,
      basis:
        history.length === 0
          ? "No comparable evaluation batch was found for these harness versions and dataset version, so a cost estimate cannot be derived from measured data."
          : "The comparable batches reported no priced usage, so a cost estimate cannot be derived.",
      measuredBatches: history.length,
      measuredCases,
      unpriced: [...new Set(history.flatMap((entry) => entry.unpriced))],
      sources: [...new Set(history.flatMap((entry) => entry.sources))],
      latencyMedianMs: median(history.map((entry) => entry.latencyMedianMs).filter((value): value is number => value !== null)),
      billedNote: "estimated",
      pricingVersion: BUILT_IN_PRICING_VERSION,
    };
  }

  const totalCost = priced.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0);
  const pricedCases = priced.reduce((sum, entry) => sum + entry.caseCount, 0);
  const perCase = pricedCases === 0 ? 0 : totalCost / pricedCases;

  return {
    estimatedCostUsd: Number((perCase * input.plannedExecutions).toFixed(6)),
    basis: `Median measured cost per case from ${priced.length} comparable batch(es) (${pricedCases} case(s)), multiplied by the ${input.plannedExecutions} planned execution(s).`,
    measuredBatches: history.length,
    measuredCases,
    unpriced: [...new Set(history.flatMap((entry) => entry.unpriced))],
    sources: [...new Set(history.flatMap((entry) => entry.sources))],
    latencyMedianMs: median(history.map((entry) => entry.latencyMedianMs).filter((value): value is number => value !== null)),
    billedNote: "estimated",
    pricingVersion: BUILT_IN_PRICING_VERSION,
  };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? null;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** What an experiment can and cannot reproduce, stated rather than implied. */
export function buildReproducibilityNotes(input: {
  replicates: number;
  selectedCases: number;
  availableCases: number;
  limited: boolean;
  estimate: ExperimentCostEstimate;
}): string[] {
  const notes = [
    "Harness versions, dataset version and evaluator revisions are pinned by id, version and content hash, so the configuration itself is reproducible exactly.",
    "Model outputs are not reproducible: a provider may return a different completion for the same prompt, and a `temperature` above 0 makes that certain. Replicates are the only way to measure that variance.",
  ];
  if (input.limited) {
    notes.push(
      `This experiment runs ${input.selectedCases} of the ${input.availableCases} cases in the pinned dataset version (case selection or cap applied); the excluded cases are not part of the verdict.`,
    );
  }
  if (input.replicates === 1) {
    notes.push("Each case was executed once per candidate, so run-to-run variance is not measured.");
  } else {
    notes.push(
      `Each case was executed ${input.replicates} times per candidate; a case counts as passed only when every scored trial passed.`,
    );
  }
  notes.push(
    "External tools (search, HTTP fetches, the clock) return live data, so a re-run may legitimately differ even with identical harnesses and inputs.",
  );
  notes.push(
    `Costs are estimates derived from the ${input.estimate.pricingVersion} price list; Orqestra has no billing integration and never reports a billed amount.`,
  );
  if (input.estimate.unpriced.length > 0) {
    notes.push(
      `These models have no known price, so their usage contributes no cost: ${input.estimate.unpriced.join(", ")}.`,
    );
  }
  return notes;
}

/** Builds the immutable configuration snapshot written at launch. */
export function buildConfigSnapshot(input: {
  configuration: ResolvedConfiguration;
}): ExperimentConfigSnapshot {
  const { configuration } = input;
  return {
    schemaVersion: 1,
    runtimeEngineVersion: RUNTIME_ENGINE_VERSION,
    pricingVersion: BUILT_IN_PRICING_VERSION,
    scoringPolicy: configuration.scoringPolicy,
    passThreshold: configuration.passThreshold,
    objective: configuration.objective,
    constraints: configuration.constraints,
    execution: configuration.execution,
    dataset: {
      id: configuration.dataset.id,
      versionId: configuration.datasetVersion.id,
      version: configuration.datasetVersion.version,
      contentHash: configuration.datasetVersion.contentHash,
      caseCount: configuration.selectedCases.length,
      availableCaseCount: configuration.availableCaseCount,
      selectedCaseKeys: configuration.selectedCases.map((entry) => entry.caseKey),
    },
    evaluators: configuration.evaluatorAssignments,
    candidates: configuration.candidates.map((candidate) => ({
      label: candidate.label,
      role: candidate.role,
      hypothesis: candidate.hypothesis,
      harnessId: candidate.harnessSnapshot.harnessId,
      harnessVersionId: candidate.harnessSnapshot.harnessVersionId,
      harnessVersion: candidate.harnessSnapshot.harnessVersion,
      contentHash: candidate.harnessSnapshot.contentHash,
    })),
    reproducibilityNotes: configuration.reproducibilityNotes,
  };
}

/**
 * Runtime limits for one case of this experiment: the author's limits, with the
 * per-case timeout applied as a ceiling (the tighter of the two wins).
 */
export function buildCaseLimits(execution: ExperimentExecution): Partial<RuntimeExecutionLimits> | null {
  const limits: Partial<RuntimeExecutionLimits> = { ...(execution.limits ?? {}) };
  if (execution.timeoutMs !== null) {
    limits.maxDurationMs =
      limits.maxDurationMs === undefined
        ? execution.timeoutMs
        : Math.min(limits.maxDurationMs, execution.timeoutMs);
  }
  return Object.keys(limits).length === 0 ? null : limits;
}

/**
 * The schedule: which case goes to which candidate, in which order.
 *
 * Interleaving is the default because ordering and time are real confounds: a
 * candidate that always runs second inherits a warmer cache, a busier provider
 * or a later price list. `baseline_first` exists for authors who want the control
 * measured on a cold system; `random` shuffles the case order deterministically
 * from the recorded seed so the schedule can be explained afterwards.
 */
export function buildSchedule(input: {
  candidates: ReadonlyArray<{ id: string }>;
  cases: ReadonlyArray<{ caseKey: string; index: number }>;
  ordering: ExperimentExecution["ordering"];
  randomSeed: number | null;
  replicates: number;
}): Array<{ candidateIndex: number; caseKey: string; index: number; replicate: number; orderIndex: number }> {
  const caseOrder = [...input.cases];
  if (input.ordering === "random") {
    shuffleInPlace(caseOrder, input.randomSeed ?? 1);
  }

  const candidateOrder = input.candidates.map((_, index) => index);
  const schedule: Array<{ candidateIndex: number; caseKey: string; index: number; replicate: number; orderIndex: number }> = [];
  let order = 0;

  if (input.ordering === "baseline_first") {
    // Candidates are the outer loop: the control runs on a cold system first,
    // then every challenger runs. (Interleaving would put the baseline first
    // within each case, which is a different thing entirely — and is what
    // "interleaved" already does.)
    for (const candidateIndex of candidateOrder) {
      for (const [position, caseEntry] of caseOrder.entries()) {
        for (let replicate = 1; replicate <= input.replicates; replicate += 1) {
          schedule.push({
            candidateIndex,
            caseKey: caseEntry.caseKey,
            index: caseEntry.index >= 0 ? caseEntry.index : position,
            replicate,
            orderIndex: order,
          });
          order += 1;
        }
      }
    }
    return schedule;
  }

  // Interleaved (and random, which only reorders the cases): one case is executed
  // by every candidate before the next case starts, so time-related drift is
  // spread across candidates instead of landing on one of them.
  for (const [position, caseEntry] of caseOrder.entries()) {
    for (const candidateIndex of candidateOrder) {
      for (let replicate = 1; replicate <= input.replicates; replicate += 1) {
        schedule.push({
          candidateIndex,
          caseKey: caseEntry.caseKey,
          index: caseEntry.index >= 0 ? caseEntry.index : position,
          replicate,
          orderIndex: order,
        });
        order += 1;
      }
    }
  }
  return schedule;
}

/** Deterministic Fisher–Yates: the same seed always yields the same schedule. */
function shuffleInPlace<T>(items: T[], seed: number): void {
  let state = seed % 2147483647;
  if (state <= 0) {
    state += 2147483646;
  }
  const next = (): number => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1));
    const current = items[index];
    const target = items[swap];
    if (current === undefined || target === undefined) {
      continue;
    }
    items[index] = target;
    items[swap] = current;
  }
}

/** Concise lines the pre-flight summary shows, built from the same definitions. */
export function describePlan(configuration: ResolvedConfiguration): {
  objective: string[];
  constraints: string[];
  notes: string[];
} {
  return {
    objective: describeObjective(configuration.objective),
    constraints: describeConstraints(configuration.constraints),
    notes: [...configuration.planned.notes, ...configuration.warnings],
  };
}

/** Re-derives a cost estimate for a cost-only summary (used by the API layer). */
export function estimateFromUsage(records: readonly PricedUsage[]): CostEstimate {
  return estimateUsageCost(records);
}

/** Used by the detail view to explain how a pass verdict was reached. */
export function describePassRule(input: {
  passThreshold: number | null;
  scoringPolicy: ScoringPolicy;
}): string {
  if (input.passThreshold === null) {
    return "No pass mark was configured, so a case passes only when every evaluator reports a pass of its own.";
  }
  return `A case counts as passed when its weighted aggregate score reaches ${input.passThreshold} and the aggregate is COMPLETE (policy: ${input.scoringPolicy}).`;
}

/** Batches created by an experiment carry this label prefix (see the launch path). */
export const EXPERIMENT_BATCH_LABEL_SEPARATOR = " · ";
