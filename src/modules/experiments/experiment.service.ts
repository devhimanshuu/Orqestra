import type { AuthUser } from "@/lib/auth/provider";
import { NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logging/logger";
import { assertAgentAccess } from "@/modules/access/access.service";
import { evaluationRepository } from "@/modules/evaluation/evaluation.repository";
import { finalizeBatch } from "@/modules/evaluation/evaluation.service";
import { isTerminalBatchStatus } from "@/modules/evaluation/batch.types";
import { estimateUsageCost } from "@/modules/evaluation/pricing";
import { sanitizeValue } from "@/modules/evaluation/sanitize";
import { promoteHarnessVersion } from "@/modules/harness/harness.service";
import { requestRunCancellation } from "@/modules/runtime/events/bus";
import { listProjects } from "@/modules/projects/project.service";
import { computeCandidateMetrics, type CandidateMetrics } from "./experiment.metrics";
import {
  buildCaseLimits,
  buildConfigSnapshot,
  buildSchedule,
  clampExecution,
  describePlan,
  draftConfigFromBody,
  draftConfigFromRecord,
  assertResolved,
  normalizeDraftConfiguration,
  resolveExperimentConfiguration,
  type ExperimentDraftConfig,
  type ResolvedConfiguration,
} from "./experiment.configuration";
import {
  buildCandidateAnalyses,
  candidateSummaries,
  loadExperiment,
  metricsAreStale,
  rankLoaded,
  toExperimentDetail,
} from "./experiment.analysis";
import {
  evaluatePromotionGates,
  verifyExperimentAuthorization,
  type ExperimentAuthorizationReport,
} from "./experiment.authorization";
import type { CandidateAnalysis, MetricComparison, RegressionFinding } from "./experiment.comparison";
import { evaluateConstraints, type ConstraintEvaluation } from "./experiment.objective";
import { rankEntries } from "./experiment.ranking";
import {
  experimentRepository,
  type DraftCandidatePin,
  type ExperimentCaseMetricRow,
} from "./experiment.repository";
import {
  assertExperimentTransition,
  isCancellableExperimentStatus,
  isLaunchableExperimentStatus,
  isPausableExperimentStatus,
  isResumableExperimentStatus,
  settleExperimentStatus,
} from "./experiment.lifecycle";
import { dispatchExperiment, type ExperimentDispatchResult } from "./jobs/dispatcher";
import {
  isTerminalExperimentStatus,
  type ExperimentCandidateRecord,
  type ExperimentCaseObservation,
  type ExperimentCandidateSummary,
  type ExperimentDetail,
  type ExperimentListItem,
  type ExperimentProgress,
  type ExperimentRecord,
  type ExperimentStatus,
  ExperimentConflictError,
  ExperimentNotFoundError,
  ExperimentPromotionError,
  ExperimentSelectionError,
} from "./experiment.types";
import type { ExperimentRanking } from "./experiment.ranking";
import type {
  CompareExperimentQuery,
  CreateExperimentBody,
  ExperimentCasesQuery,
  ExportExperimentQuery,
  LaunchExperimentBody,
  ListExperimentsQuery,
  PromoteCandidateBody,
  SelectCandidateBody,
  UpdateExperimentBody,
} from "./experiment.inputs";

/**
 * Experiment service — the only entry point for experiment operations.
 *
 * Authorization chain (never trusting client ids):
 *   user → workspace → project → agent → harness version / dataset / evaluators
 *
 * Sealing, exactly like an evaluation batch: at launch the experiment snapshots
 * the dataset cases, every evaluator revision, the objective, the constraints and
 * the execution settings. After that, editing a harness, a dataset or an
 * evaluator cannot change what a stored experiment means.
 *
 * Execution is delegated, never re-implemented: each candidate-replicate gets a
 * sealed `EvaluationBatch`, and the orchestrator runs its cases through the same
 * case runner the Phase 3 engine uses. This module schedules and interprets; it
 * never executes a node or scores a case itself.
 */

const serviceLogger = logger.child({ module: "experiments" });

// ------------------------------------------------------------------------------
// Pre-flight
// ------------------------------------------------------------------------------

export interface ExperimentPlan {
  configuration: {
    name: string;
    agentId: string;
    agentName: string;
    datasetId: string;
    datasetName: string;
    datasetVersionId: string;
    datasetVersion: number;
    caseCount: number;
    availableCaseCount: number;
    baseline: {
      label: string;
      harnessId: string;
      harnessVersionId: string;
      harnessVersion: number;
      harnessName: string;
    };
    candidates: Array<{
      label: string;
      harnessId: string;
      harnessVersionId: string;
      harnessVersion: number;
      harnessName: string;
      hypothesis: string | null;
    }>;
    evaluators: Array<{ key: string; name: string; kind: string; version: number; weight: number; usesLlm: boolean }>;
    objective: ResolvedConfiguration["objective"];
    constraints: ResolvedConfiguration["constraints"];
    execution: ResolvedConfiguration["execution"];
    scoringPolicy: ResolvedConfiguration["scoringPolicy"];
    passThreshold: number | null;
  };
  volume: {
    candidateCount: number;
    caseCount: number;
    replicates: number;
    plannedExecutions: number;
    exceedsRunBudget: boolean;
    runBudget: number | null;
  };
  estimate: ResolvedConfiguration["estimate"];
  checks: Array<{ level: "ok" | "warning" | "error"; message: string }>;
  lines: { objective: string[]; constraints: string[]; notes: string[] };
  reproducibilityNotes: string[];
  valid: boolean;
  issues: Array<{ path: string; message: string }>;
}

function toPlan(name: string, configuration: ResolvedConfiguration): ExperimentPlan {
  const baseline = configuration.candidates.find((candidate) => candidate.role === "BASELINE");
  const candidates = configuration.candidates.filter((candidate) => candidate.role !== "BASELINE");

  const checks: ExperimentPlan["checks"] = configuration.issues.map((issue) => ({
    level: "error" as const,
    message: `${issue.path}: ${issue.message}`,
  }));
  for (const warning of configuration.warnings) {
    checks.push({ level: "warning", message: warning });
  }
  if (configuration.issues.length === 0) {
    checks.unshift({
      level: "ok",
      message:
        configuration.warnings.length === 0
          ? "The configuration is runnable exactly as specified."
          : "No blocking problems were found; the notes below describe what the configuration does and does not prove.",
    });
  }

  return {
    configuration: {
      name,
      agentId: configuration.agent.id,
      agentName: configuration.agent.name,
      datasetId: configuration.dataset.id,
      datasetName: configuration.dataset.name,
      datasetVersionId: configuration.datasetVersion.id,
      datasetVersion: configuration.datasetVersion.version,
      caseCount: configuration.selectedCases.length,
      availableCaseCount: configuration.availableCaseCount,
      baseline:
        baseline === undefined
          ? { label: "Baseline", harnessId: "", harnessVersionId: "", harnessVersion: 0, harnessName: "" }
          : {
              label: baseline.label,
              harnessId: baseline.harness.id,
              harnessVersionId: baseline.harnessVersion.id,
              harnessVersion: baseline.harnessVersion.version,
              harnessName: baseline.harness.name,
            },
      candidates: candidates.map((candidate) => ({
        label: candidate.label,
        harnessId: candidate.harness.id,
        harnessVersionId: candidate.harnessVersion.id,
        harnessVersion: candidate.harnessVersion.version,
        harnessName: candidate.harness.name,
        hypothesis: candidate.hypothesis,
      })),
      evaluators: configuration.evaluatorAssignments.map((assignment) => ({
        key: assignment.key,
        name: assignment.name,
        kind: assignment.kind,
        version: assignment.evaluatorVersion,
        weight: assignment.weight,
        usesLlm: assignment.usesLlm,
      })),
      objective: configuration.objective,
      constraints: configuration.constraints,
      execution: configuration.execution,
      scoringPolicy: configuration.scoringPolicy,
      passThreshold: configuration.passThreshold,
    },
    volume: {
      candidateCount: configuration.candidates.length,
      caseCount: configuration.selectedCases.length,
      replicates: configuration.execution.replicates,
      plannedExecutions: configuration.planned.plannedExecutions,
      exceedsRunBudget: configuration.planned.exceedsRunBudget,
      runBudget: configuration.planned.runBudget,
    },
    estimate: configuration.estimate,
    checks,
    lines: describePlan(configuration),
    reproducibilityNotes: configuration.reproducibilityNotes,
    valid: configuration.issues.length === 0,
    issues: configuration.issues,
  };
}

/** Pre-flight for a configuration the caller has not saved yet. */
export async function planNewExperiment(user: AuthUser, body: CreateExperimentBody): Promise<ExperimentPlan> {
  const configuration = await resolveExperimentConfiguration(user, draftConfigFromBody(body));
  return toPlan(body.name, configuration);
}

/** Pre-flight for a stored experiment (the review step re-runs it before launch). */
export async function planStoredExperiment(user: AuthUser, experimentId: string): Promise<ExperimentPlan> {
  const record = await requireExperiment(user, experimentId);
  const candidates = await experimentRepository.listCandidates(experimentId);
  const configuration = await resolveExperimentConfiguration(user, draftConfigFromRecord(record, candidates));
  return toPlan(record.name, configuration);
}

// ------------------------------------------------------------------------------
// Drafts
// ------------------------------------------------------------------------------

/** The columns a resolved configuration contributes to the experiment row. */
function draftConfigColumns(configuration: ResolvedConfiguration) {
  const normalized = normalizeDraftConfiguration({
    objective: configuration.objective,
    constraints: configuration.constraints,
    execution: clampExecution(configuration.execution),
  });
  return {
    datasetId: configuration.dataset.id,
    datasetVersionId: configuration.datasetVersion.id,
    datasetSnapshot: configuration.selectedCases,
    evaluatorConfig: configuration.evaluatorAssignments,
    scoringPolicy: configuration.scoringPolicy,
    passThreshold: configuration.passThreshold,
    objective: normalized.objective,
    constraints: normalized.constraints,
    execution: normalized.execution,
    caseCount: configuration.selectedCases.length,
    plannedRunCount: configuration.planned.plannedExecutions,
  };
}

/**
 * Pins every resolved selection — baseline first — to its immutable harness
 * version. Drafts persist these rows so the stored draft round-trips: the
 * pre-flight, edit and seal paths re-read them instead of the original body.
 */
function draftCandidatePins(configuration: ResolvedConfiguration): DraftCandidatePin[] {
  return configuration.candidates.map((candidate) => ({
    label: candidate.label,
    role: candidate.role,
    hypothesis: candidate.hypothesis,
    orderIndex: candidate.orderIndex,
    harnessId: candidate.harness.id,
    harnessVersionId: candidate.harnessVersion.id,
    harnessVersion: candidate.harnessVersion.version,
    contentHash: candidate.harnessVersion.contentHash,
    harnessSnapshot: candidate.harnessSnapshot,
  }));
}

/** Creates a DRAFT: everything is resolved and validated, nothing is scheduled. */
export async function createExperiment(
  user: AuthUser,
  body: CreateExperimentBody,
): Promise<ExperimentRecord> {
  await assertAgentAccess(user.id, body.agentId);
  const configuration = await resolveExperimentConfiguration(user, draftConfigFromBody(body));
  assertResolved(configuration);

  const record = await experimentRepository.createDraft({
    projectId: configuration.agent.projectId,
    agentId: configuration.agent.id,
    name: body.name,
    description: body.description ?? null,
    hypothesis: body.hypothesis ?? null,
    ...draftConfigColumns(configuration),
    candidates: draftCandidatePins(configuration),
    createdBy: user.id,
  });

  serviceLogger.info("experiment draft created", {
    experimentId: record.id,
    agentId: record.agentId,
    candidates: configuration.candidates.length,
    cases: configuration.selectedCases.length,
    plannedExecutions: configuration.planned.plannedExecutions,
    userId: user.id,
  });
  return record;
}

/** Updates a draft. Sealed experiments are immutable, so this only accepts DRAFT. */
export async function updateExperiment(
  user: AuthUser,
  experimentId: string,
  body: UpdateExperimentBody,
): Promise<ExperimentRecord> {
  const record = await requireExperiment(user, experimentId);
  if (record.status !== "DRAFT") {
    throw new ExperimentConflictError(
      `This experiment is ${record.status.toLowerCase()}; its configuration is sealed and cannot be edited. Create a new experiment to compare something else.`,
    );
  }

  const storedCandidates = await experimentRepository.listCandidates(experimentId);
  const current = draftConfigFromRecord(record, storedCandidates);
  const merged: ExperimentDraftConfig = {
    name: body.name ?? current.name,
    description: body.description === undefined ? current.description : body.description,
    hypothesis: body.hypothesis === undefined ? current.hypothesis : body.hypothesis,
    agentId: current.agentId,
    datasetId: body.datasetId ?? current.datasetId,
    datasetVersionId: body.datasetVersionId ?? current.datasetVersionId,
    baseline: {
      harnessVersionId: body.baseline?.harnessVersionId ?? current.baseline.harnessVersionId,
      label: body.baseline?.label ?? current.baseline.label,
      hypothesis: body.baseline?.hypothesis ?? current.baseline.hypothesis,
    },
    candidates:
      body.candidates === undefined
        ? current.candidates
        : body.candidates.map((candidate) => ({
            harnessVersionId: candidate.harnessVersionId,
            label: candidate.label ?? null,
            hypothesis: candidate.hypothesis ?? null,
          })),
    evaluators: body.evaluators ?? current.evaluators,
    scoringPolicy: body.scoringPolicy ?? current.scoringPolicy,
    passThreshold: body.passThreshold === undefined ? current.passThreshold : body.passThreshold,
    objective: body.objective ?? current.objective,
    constraints: body.constraints ?? current.constraints,
    execution: body.execution ?? current.execution,
  };

  const configuration = await resolveExperimentConfiguration(user, merged);
  assertResolved(configuration);

  const updated = await experimentRepository.updateDraft(experimentId, {
    name: merged.name,
    description: merged.description,
    hypothesis: merged.hypothesis,
    ...draftConfigColumns(configuration),
    // Only rewrite candidate rows when the pins themselves could have moved —
    // a rename must not churn identical rows.
    ...(body.candidates !== undefined || body.baseline !== undefined
      ? { candidates: draftCandidatePins(configuration) }
      : {}),
  });
  serviceLogger.info("experiment draft updated", { experimentId, userId: user.id });
  return updated;
}

// ------------------------------------------------------------------------------
// Launch
// ------------------------------------------------------------------------------

export interface LaunchedExperiment {
  experiment: ExperimentRecord;
  dispatch: ExperimentDispatchResult;
  /** Differences between the stored draft and what was actually sealed. */
  changes: string[];
}

/**
 * Seals a draft: the immutable configuration snapshot, one sealed evaluation
 * batch per candidate replicate, and the assignment rows that fix the execution
 * order. Nothing is dispatched here.
 *
 * The seal is re-resolved from the database rather than trusted from the draft:
 * evaluator revisions are looked up again, harness versions are re-compiled, and
 * every difference from what the draft recorded is reported in `changes` — so a
 * revision that moved on between editing and launching is visible, not silent.
 *
 * Splitting the seal from the dispatch is deliberate: sealing is the expensive,
 * irreversible act, while dispatch is a transport decision. It also means a
 * caller can seal an experiment and let a worker pick it up later.
 */
export async function sealExperiment(
  user: AuthUser,
  experimentId: string,
): Promise<{ experiment: ExperimentRecord; changes: string[] }> {
  const record = await requireExperiment(user, experimentId);
  if (!isLaunchableExperimentStatus(record.status)) {
    throw new ExperimentConflictError(
      `This experiment is ${record.status.toLowerCase()} and cannot be launched again.`,
    );
  }

  const storedCandidates = await experimentRepository.listCandidates(experimentId);
  const configuration = await resolveExperimentConfiguration(
    user,
    draftConfigFromRecord(record, storedCandidates),
  );
  assertResolved(configuration);

  const clash = await experimentRepository.findInFlight(record.agentId, configuration.datasetVersion.id);
  if (clash !== null) {
    throw new ExperimentConflictError(
      `An experiment for this agent and dataset version is already running (${clash.id.slice(-6)}). Wait for it to finish so the comparison stays unambiguous.`,
    );
  }

  const changes = describeChanges(record, storedCandidates, configuration);
  const configSnapshot = buildConfigSnapshot({ configuration });
  const limits = buildCaseLimits(configuration.execution);

  // One sealed batch per (candidate, replicate): the batch owns case rows, runs
  // and verdicts; the experiment layer schedules when each case runs.
  const createdBatchIds: string[] = [];
  const launchCandidates: Array<{
    label: string;
    role: "BASELINE" | "CANDIDATE";
    hypothesis: string | null;
    orderIndex: number;
    harnessId: string;
    harnessVersionId: string;
    harnessVersion: number;
    contentHash: string;
    harnessSnapshot: ResolvedConfiguration["candidates"][number]["harnessSnapshot"];
    replicates: Array<{ replicate: number; evaluationBatchId: string }>;
    assignments: Array<{ caseKey: string; index: number; orderIndex: number; replicate: number }>;
  }> = [];

  try {
    for (const candidate of configuration.candidates) {
      const replicates: Array<{ replicate: number; evaluationBatchId: string }> = [];
      for (let replicate = 1; replicate <= configuration.execution.replicates; replicate += 1) {
        const label = `${record.name} · ${candidate.label}${replicate > 1 ? ` · trial ${replicate}` : ""}`;
        const batch = await evaluationRepository.createBatch({
          projectId: configuration.agent.projectId,
          label,
          agentId: configuration.agent.id,
          harnessId: candidate.harness.id,
          harnessVersionId: candidate.harnessVersion.id,
          datasetId: configuration.dataset.id,
          datasetVersionId: configuration.datasetVersion.id,
          datasetSnapshot: configuration.selectedCases,
          evaluatorConfig: configuration.evaluatorAssignments,
          harnessSnapshot: candidate.harnessSnapshot,
          scoringPolicy: configuration.scoringPolicy,
          passThreshold: configuration.passThreshold,
          // Case-level parallelism lives in the experiment orchestrator (it
          // interleaves candidates); a candidate's batch schedules nothing.
          config: { concurrency: 1, limits },
          createdBy: user.id,
        });
        createdBatchIds.push(batch.id);
        replicates.push({ replicate, evaluationBatchId: batch.id });
      }

      launchCandidates.push({
        label: candidate.label,
        role: candidate.role,
        hypothesis: candidate.hypothesis,
        orderIndex: candidate.orderIndex,
        harnessId: candidate.harness.id,
        harnessVersionId: candidate.harnessVersion.id,
        harnessVersion: candidate.harnessVersion.version,
        contentHash: candidate.harnessVersion.contentHash,
        harnessSnapshot: candidate.harnessSnapshot,
        replicates,
        assignments: [],
      });
    }

    const schedule = buildSchedule({
      candidates: launchCandidates.map((candidate) => ({ id: candidate.label })),
      cases: configuration.selectedCases.map((entry, index) => ({ caseKey: entry.caseKey, index })),
      ordering: configuration.execution.ordering,
      randomSeed: configuration.execution.randomSeed,
      replicates: configuration.execution.replicates,
    });

    for (const entry of schedule) {
      const candidate = launchCandidates[entry.candidateIndex];
      if (candidate === undefined) {
        continue;
      }
      candidate.assignments.push({
        caseKey: entry.caseKey,
        index: entry.index,
        orderIndex: entry.orderIndex,
        replicate: entry.replicate,
      });
    }

    await experimentRepository.createLaunchPlan({
      experimentId,
      configSnapshot,
      plannedRunCount: configuration.planned.plannedExecutions,
      caseCount: configuration.selectedCases.length,
      startedAt: new Date(),
      candidates: launchCandidates,
    });
  } catch (error) {
    // A failed seal must not leave orphaned batches behind: they were never
    // dispatched, so they carry no results and can be removed safely.
    for (const batchId of createdBatchIds) {
      await evaluationRepository.deleteUnstartedBatch(batchId).catch(() => undefined);
    }
    throw error;
  }

  const refreshed = await experimentRepository.findById(experimentId);
  return { experiment: refreshed ?? record, changes };
}

/**
 * Seals a draft and dispatches it.
 *
 * The dispatch is the only part that depends on infrastructure: `auto` probes
 * Redis and falls back to in-process execution, `queue` requires a worker, and
 * `inline` runs in this process. Either way the same orchestrator executes the
 * experiment — only the transport differs.
 */
export async function launchExperiment(
  user: AuthUser,
  experimentId: string,
  body: LaunchExperimentBody,
): Promise<LaunchedExperiment> {
  const sealed = await sealExperiment(user, experimentId);
  const launched = sealed.experiment;
  const dispatch = await dispatchExperiment(launched.id);

  serviceLogger.info("experiment launched", {
    experimentId: launched.id,
    confirmed: body.confirm,
    caseCount: launched.caseCount,
    plannedExecutions: launched.plannedRunCount,
    mode: dispatch.mode,
    userId: user.id,
  });

  return { experiment: launched, dispatch, changes: sealed.changes };
}

/** What moved between the stored draft and the configuration actually sealed. */
function describeChanges(
  record: ExperimentRecord,
  storedCandidates: ExperimentCandidateRecord[],
  configuration: ResolvedConfiguration,
): string[] {
  const changes: string[] = [];
  const storedEvaluators = new Map(
    record.evaluatorConfig.map((entry) => [entry.evaluatorId, entry.evaluatorVersion]),
  );
  for (const assignment of configuration.evaluatorAssignments) {
    const previous = storedEvaluators.get(assignment.evaluatorId);
    if (previous !== undefined && previous !== assignment.evaluatorVersion) {
      changes.push(
        `Evaluator "${assignment.name}" was at revision v${previous} when the draft was saved and is now pinned at v${assignment.evaluatorVersion}.`,
      );
    }
  }
  if (record.caseCount !== configuration.selectedCases.length) {
    changes.push(
      `The case selection now covers ${configuration.selectedCases.length} case(s) instead of the ${record.caseCount} recorded on the draft.`,
    );
  }
  const storedLabels = new Set(storedCandidates.map((candidate) => candidate.label));
  if (storedLabels.size === 0) {
    changes.push("Candidates were first written at launch time.");
  }
  return changes;
}

// ------------------------------------------------------------------------------
// Reads
// ------------------------------------------------------------------------------

/** Loads an experiment and asserts the caller may see its agent's project. */
async function requireExperiment(user: AuthUser, experimentId: string): Promise<ExperimentRecord> {
  const record = await experimentRepository.findById(experimentId);
  if (record === null) {
    throw new ExperimentNotFoundError(experimentId);
  }
  try {
    await assertAgentAccess(user.id, record.agentId);
  } catch (error) {
    // Someone outside the workspace gets the same answer as a nonexistent
    // experiment: existence is never disclosed across workspaces.
    if (error instanceof NotFoundError) {
      throw new ExperimentNotFoundError(experimentId);
    }
    throw error;
  }
  return record;
}

async function scopedProjectIds(user: AuthUser): Promise<string[]> {
  const projects = await listProjects(user);
  return projects.map((project) => project.id);
}

/**
 * The experiments table.
 *
 * The leading candidate comes from the stored metrics and the configured rules —
 * never from a hardcoded label — and this view ranks *without* per-case analysis,
 * so it makes no statistical claim (the comparison view makes those).
 */
export async function listExperiments(
  user: AuthUser,
  query: ListExperimentsQuery,
): Promise<{ items: ExperimentListItem[]; total: number; limit: number; offset: number }> {
  const projectIds = await scopedProjectIds(user);
  if (projectIds.length === 0) {
    return { items: [], total: 0, limit: query.limit ?? 20, offset: query.offset ?? 0 };
  }
  if (query.agentId !== undefined) {
    await assertAgentAccess(user.id, query.agentId);
  }

  const page = await experimentRepository.list({
    projectIds,
    ...(query.agentId !== undefined ? { agentId: query.agentId } : {}),
    ...(query.datasetId !== undefined ? { datasetId: query.datasetId } : {}),
    ...(query.status !== undefined && query.status.length > 0 ? { status: query.status } : {}),
    ...(query.q !== undefined ? { q: query.q } : {}),
    sort: query.sort,
    order: query.order,
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
    ...(query.offset !== undefined ? { offset: query.offset } : {}),
  });

  const items = page.items.map((item) => {
    const context = page.rankingInputs.get(item.id);
    if (context === undefined || context.metrics === null) {
      return item;
    }
    // The same rules as the comparison view, over the stored metrics only: this
    // view has no per-case data, so it names a leader without a statistical claim.
    const ranking = rankEntries({
      objective: context.objective,
      constraints: context.constraints,
      status: context.status,
      baselineCandidateId: null,
      entries: context.metrics.candidates.map((metrics) => ({ metrics, analysis: null })),
    });
    return {
      ...item,
      leadingCandidateLabel: ranking.leader?.label ?? null,
      leaderNote: ranking.leaderNote,
    };
  });

  return { items, total: page.total, limit: page.limit, offset: page.offset };
}

export async function getExperiment(user: AuthUser, experimentId: string): Promise<ExperimentDetail> {
  const record = await requireExperiment(user, experimentId);
  const [loaded, meta] = await Promise.all([
    loadExperiment(record),
    experimentRepository.findMeta(experimentId),
  ]);
  return toExperimentDetail({ loaded, agent: meta.agent, dataset: meta.dataset });
}

export async function getExperimentProgress(
  user: AuthUser,
  experimentId: string,
): Promise<ExperimentProgress> {
  const record = await requireExperiment(user, experimentId);
  const loaded = await loadExperiment(record);
  return loaded.progress;
}

export interface ExperimentMetricsView {
  experiment: ExperimentRecord;
  progress: ExperimentProgress;
  candidates: ExperimentCandidateSummary[];
  metrics: CandidateMetrics[];
  ranking: ExperimentRanking;
  constraintStatus: Array<{
    candidateId: string;
    violated: number;
    satisfied: number;
    unknown: number;
    checks: ConstraintEvaluation["checks"];
  }>;
}

/**
 * Candidate metrics plus the objective-based ranking.
 *
 * `withAnalysis` controls whether the per-case comparison runs: the detail page
 * shows constraints and the leader (metrics only), while the comparison page adds
 * paired evidence and regression findings.
 */
export async function getExperimentMetricsView(
  user: AuthUser,
  experimentId: string,
  options: { withAnalysis: boolean },
): Promise<ExperimentMetricsView> {
  const record = await requireExperiment(user, experimentId);
  const loaded = await loadExperiment(record);
  const analyses = options.withAnalysis
    ? buildCandidateAnalyses({
        experiment: loaded.experiment,
        candidates: loaded.candidates,
        byCandidate: loaded.byCandidate,
      })
    : undefined;
  const ranking = rankLoaded({
    experiment: loaded.experiment,
    candidates: loaded.candidates,
    byCandidate: loaded.byCandidate,
    ...(analyses !== undefined ? { analyses } : {}),
  });

  return {
    experiment: loaded.experiment,
    progress: loaded.progress,
    candidates: candidateSummaries({ loaded }),
    metrics: collectCandidateMetrics(loaded),
    ranking,
    constraintStatus: ranking.candidates.map((entry) => ({
      candidateId: entry.metrics.candidateId,
      violated: entry.constraints.violated,
      satisfied: entry.constraints.satisfied,
      unknown: entry.constraints.unknown,
      checks: entry.constraints.checks,
    })),
  };
}

export interface ExperimentCandidatesView {
  experiment: { id: string; name: string; status: ExperimentStatus };
  candidates: ExperimentCandidateSummary[];
  metrics: CandidateMetrics[];
  ranking: ExperimentRanking;
}

/**
 * Candidates with their metrics and rank, from a single load.
 *
 * Metrics-only (no per-case analysis): this is the endpoint a candidate picker or
 * a compact table reads, and it stays cheap on a long experiment.
 */
export async function getExperimentCandidates(
  user: AuthUser,
  experimentId: string,
): Promise<ExperimentCandidatesView> {
  const record = await requireExperiment(user, experimentId);
  const loaded = await loadExperiment(record);
  const ranking = rankLoaded({
    experiment: loaded.experiment,
    candidates: loaded.candidates,
    byCandidate: loaded.byCandidate,
  });
  return {
    experiment: { id: record.id, name: record.name, status: record.status },
    candidates: candidateSummaries({ loaded }),
    metrics: collectCandidateMetrics(loaded),
    ranking,
  };
}

/** Every candidate has metrics in a loaded experiment by construction. */
function collectCandidateMetrics(loaded: {
  candidates: ExperimentCandidateRecord[];
  byCandidate: Map<string, { metrics: CandidateMetrics }>;
}): CandidateMetrics[] {
  return loaded.candidates.map((candidate) => {
    const metrics = loaded.byCandidate.get(candidate.id)?.metrics;
    return (
      metrics ??
      computeCandidateMetrics({
        candidateId: candidate.id,
        label: candidate.label,
        role: candidate.role,
        harnessVersionId: candidate.harnessVersionId,
        harnessVersion: candidate.harnessVersion,
        policy: "REQUIRE_ALL",
        plannedExecutions: 0,
        rows: [] as ExperimentCaseMetricRow[],
      })
    );
  });
}

export interface ExperimentCaseView {
  caseKey: string;
  index: number;
  name: string | null;
  tags: string[];
  baseline: ExperimentCaseObservation | null;
  candidates: Array<{ candidateId: string; label: string; observation: ExperimentCaseObservation | null }>;
}

/** Cases aligned by stable `caseKey`, with the baseline side beside each candidate. */
export async function listExperimentCases(
  user: AuthUser,
  experimentId: string,
  query: ExperimentCasesQuery,
): Promise<{ cases: ExperimentCaseView[]; total: number; limit: number; offset: number }> {
  const record = await requireExperiment(user, experimentId);
  const loaded = await loadExperiment(record);
  return buildCaseViews(loaded, query);
}

function buildCaseViews(
  loaded: Awaited<ReturnType<typeof loadExperiment>>,
  query: Pick<ExperimentCasesQuery, "candidateId" | "status" | "limit" | "offset">,
): { cases: ExperimentCaseView[]; total: number; limit: number; offset: number } {
  const record = loaded.experiment;
  const baseline =
    loaded.candidates.find((candidate) => candidate.role === "BASELINE") ?? loaded.candidates[0] ?? null;
  const others = loaded.candidates.filter((candidate) => candidate.id !== baseline?.id);
  const requested =
    query.candidateId === undefined ? others : others.filter((candidate) => candidate.id === query.candidateId);
  const observed = requested.length > 0 ? requested : others;

  const aligned: ExperimentCaseView[] = record.datasetSnapshot.map((sample, index) => {
    const baselineObservation =
      (baseline === null
        ? undefined
        : loaded.byCandidate
            .get(baseline.id)
            ?.observations.find((entry) => entry.caseKey === sample.caseKey)) ?? null;
    return {
      caseKey: sample.caseKey,
      index,
      name: sample.name,
      tags: sample.tags,
      baseline: baselineObservation,
      candidates: observed.map((candidate) => ({
        candidateId: candidate.id,
        label: candidate.label,
        observation:
          loaded.byCandidate
            .get(candidate.id)
            ?.observations.find((entry) => entry.caseKey === sample.caseKey) ?? null,
      })),
    };
  });

  const filtered =
    query.status === undefined || query.status.length === 0
      ? aligned
      : aligned.filter((entry) => {
          const statuses = [
            ...(entry.baseline?.trials.map((trial) => trial.status) ?? []),
            ...entry.candidates.flatMap((side) => side.observation?.trials.map((trial) => trial.status) ?? []),
          ];
          return statuses.some((status) => query.status?.includes(status));
        });

  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const offset = Math.max(query.offset ?? 0, 0);
  return {
    cases: filtered.slice(offset, offset + limit),
    total: filtered.length,
    limit,
    offset,
  };
}

// ------------------------------------------------------------------------------
// Comparison
// ------------------------------------------------------------------------------

export interface ExperimentComparisonCandidate {
  metrics: CandidateMetrics;
  analysis: CandidateAnalysis | null;
  constraints: ConstraintEvaluation;
  primary: MetricComparison | null;
  secondary: MetricComparison[];
  regressions: RegressionFinding[];
  pathChanges: RegressionFinding[];
  notes: string[];
  rank: number | null;
  eligibleForWin: boolean;
  winBlockers: string[];
  reasons: string[];
}

export interface ExperimentComparisonResult {
  experiment: ExperimentRecord;
  baselineCandidateId: string | null;
  baseline: { metrics: CandidateMetrics; analysis: CandidateAnalysis | null } | null;
  candidates: ExperimentComparisonCandidate[];
  ranking: ExperimentRanking;
  cases: ExperimentCaseView[];
  settled: boolean;
}

export async function compareExperiment(
  user: AuthUser,
  experimentId: string,
  query: CompareExperimentQuery,
): Promise<ExperimentComparisonResult> {
  const record = await requireExperiment(user, experimentId);
  const loaded = await loadExperiment(record);
  const analyses = buildCandidateAnalyses({
    experiment: loaded.experiment,
    candidates: loaded.candidates,
    byCandidate: loaded.byCandidate,
  });
  const ranking = rankLoaded({
    experiment: loaded.experiment,
    candidates: loaded.candidates,
    byCandidate: loaded.byCandidate,
    analyses,
  });

  const baselineRecord =
    loaded.candidates.find((candidate) => candidate.role === "BASELINE") ?? loaded.candidates[0] ?? null;

  if (query.baselineCandidateId !== undefined) {
    const requested = loaded.candidates.find((candidate) => candidate.id === query.baselineCandidateId);
    if (requested === undefined) {
      throw new NotFoundError("Baseline candidate not found in this experiment");
    }
  }

  let selected =
    query.candidateId === undefined
      ? loaded.candidates.filter((candidate) => candidate.id !== baselineRecord?.id)
      : loaded.candidates.filter((candidate) => candidate.id === query.candidateId);
  if (query.candidateId !== undefined && selected.length === 0) {
    throw new NotFoundError("Candidate not found in this experiment");
  }
  if (query.regressionsOnly) {
    selected = selected.filter((candidate) => (analyses.get(candidate.id)?.regressions.length ?? 0) > 0);
  }

  const cases = query.includeCases
    ? buildCaseViews(loaded, { candidateId: undefined, status: undefined, limit: 200, offset: 0 })
    : { cases: [], total: 0, limit: 0, offset: 0 };

  return {
    experiment: record,
    baselineCandidateId: baselineRecord?.id ?? null,
    baseline:
      baselineRecord === null
        ? null
        : {
            metrics:
              loaded.byCandidate.get(baselineRecord.id)?.metrics ??
              collectCandidateMetrics(loaded).find(
                (entry) => entry.candidateId === baselineRecord.id,
              ) ??
              collectCandidateMetrics(loaded)[0]!,
            analysis: analyses.get(baselineRecord.id) ?? null,
          },
    candidates: selected.map((candidate) => {
      const analysis = analyses.get(candidate.id) ?? null;
      const entry = ranking.candidates.find((item) => item.metrics.candidateId === candidate.id);
      const metrics =
        loaded.byCandidate.get(candidate.id)?.metrics ??
        collectCandidateMetrics(loaded).find((item) => item.candidateId === candidate.id) ??
        collectCandidateMetrics(loaded)[0]!;
      return {
        metrics,
        analysis,
        constraints: entry?.constraints ?? evaluateConstraints(metrics, record.constraints),
        primary: analysis?.primary ?? null,
        secondary: analysis?.secondary ?? [],
        regressions: analysis?.regressions ?? [],
        pathChanges: analysis?.pathChanges ?? [],
        notes: analysis?.notes ?? [],
        rank: entry?.rank ?? null,
        eligibleForWin: entry?.eligibleForWin ?? false,
        winBlockers: entry?.winBlockers ?? [],
        reasons: entry?.reasons ?? [],
      };
    }),
    ranking,
    cases: cases.cases,
    settled: ranking.settled,
  };
}

// ------------------------------------------------------------------------------
// Lifecycle
// ------------------------------------------------------------------------------

/**
 * Cancels an experiment: records the durable intent, aborts the runs already in
 * flight through the runtime's own cancellation channel, marks every case that
 * never started as cancelled and settles each candidate's batches. Results that
 * were already produced are kept — cancelling stops work, it does not erase
 * evidence.
 */
export async function cancelExperiment(
  user: AuthUser,
  experimentId: string,
): Promise<{ experiment: ExperimentRecord; runningExecutions: number }> {
  const record = await requireExperiment(user, experimentId);
  if (!isCancellableExperimentStatus(record.status)) {
    throw new ExperimentConflictError(
      `This experiment is already ${record.status.toLowerCase()} and cannot be cancelled.`,
    );
  }

  await experimentRepository.requestCancellation(experimentId);

  // Batch ids come from the candidates' sealed replicates — the only records that
  // pair a candidate with its execution vehicle. Deriving them from the assignment
  // rows instead would mean each assignment had to repeat a batch pointer.
  const candidates = await experimentRepository.listCandidates(experimentId);
  const batchIds = [...new Set(candidates.flatMap((candidate) => candidate.replicates.map((r) => r.evaluationBatchId)))];
  const statuses = await experimentRepository.listCaseStatuses(batchIds);

  const running = statuses.filter((entry) => entry.status === "RUNNING" && entry.runId !== null);
  for (const entry of running) {
    if (entry.runId !== null) {
      await requestRunCancellation(entry.runId, `experiment ${experimentId} cancelled`);
    }
  }

  const pending = statuses.filter((entry) => entry.status === "PENDING");
  if (running.length === 0) {
    for (const entry of pending) {
      if (entry.caseResultId === null) {
        continue;
      }
      await evaluationRepository.completeCase(entry.evaluationBatchId, entry.caseResultId, {
        status: "CANCELLED",
        error: {
          kind: "cancelled",
          code: "EXPERIMENT_CANCELLED",
          message: "Cancelled before this case started.",
        },
        incrementCompleted: false,
        incrementFailed: false,
      });
    }
    await finalizeExperiment(experimentId, { budgetStop: false });
  }

  serviceLogger.info("experiment cancellation requested", {
    experimentId,
    runningExecutions: running.length,
    userId: user.id,
  });
  const refreshed = await experimentRepository.findById(experimentId);
  return { experiment: refreshed ?? record, runningExecutions: running.length };
}

export async function pauseExperiment(user: AuthUser, experimentId: string): Promise<ExperimentRecord> {
  const record = await requireExperiment(user, experimentId);
  if (!isPausableExperimentStatus(record.status)) {
    throw new ExperimentConflictError(
      record.status === "PAUSED"
        ? "This experiment is already paused."
        : `A ${record.status.toLowerCase()} experiment cannot be paused.`,
    );
  }
  const paused = await experimentRepository.requestPause(experimentId);
  if (!paused) {
    throw new ExperimentConflictError(
      "The experiment moved on before it could be paused — reload and try again.",
    );
  }
  serviceLogger.info("experiment paused", { experimentId, userId: user.id });
  const refreshed = await experimentRepository.findById(experimentId);
  return refreshed ?? record;
}

/**
 * Resumes a paused experiment.
 *
 * Safe to call twice: the orchestrator claims each case with a conditional update
 * (PENDING → RUNNING), so only executions that never started are picked up and
 * finished work is never replayed.
 */
export async function resumeExperiment(
  user: AuthUser,
  experimentId: string,
): Promise<{ experiment: ExperimentRecord; dispatch: ExperimentDispatchResult }> {
  const record = await requireExperiment(user, experimentId);
  if (!isResumableExperimentStatus(record.status)) {
    throw new ExperimentConflictError(
      `Only a paused experiment can be resumed; this one is ${record.status.toLowerCase()}.`,
    );
  }
  const resumed = await experimentRepository.clearPause(experimentId);
  if (!resumed) {
    throw new ExperimentConflictError("The experiment could not be resumed — reload and try again.");
  }
  const dispatch = await dispatchExperiment(experimentId);
  serviceLogger.info("experiment resumed", { experimentId, mode: dispatch.mode, userId: user.id });
  const refreshed = await experimentRepository.findById(experimentId);
  return { experiment: refreshed ?? record, dispatch };
}

/**
 * Settles an experiment: persists metrics computed from the persisted case rows,
 * finalizes every candidate batch that has nothing outstanding, and derives the
 * terminal status. Idempotent — running it twice produces the same state.
 */
export async function finalizeExperiment(
  experimentId: string,
  options: { budgetStop: boolean },
): Promise<ExperimentRecord | null> {
  const record = await experimentRepository.findById(experimentId);
  if (record === null) {
    return null;
  }

  const loaded = await loadExperiment(record);

  for (const candidate of loaded.candidates) {
    for (const replicate of candidate.replicates) {
      const batch = await evaluationRepository.findById(replicate.evaluationBatchId);
      if (batch !== null && !isTerminalBatchStatus(batch.status)) {
        const counts = await evaluationRepository.countsByStatus(replicate.evaluationBatchId);
        if (counts.PENDING + counts.RUNNING === 0) {
          await finalizeBatch(replicate.evaluationBatchId);
        }
      }
    }
  }

  const metrics = loaded.experimentMetrics;
  await experimentRepository.saveMetrics(experimentId, metrics);

  const status: ExperimentStatus = settleExperimentStatus({
    completed: metrics.completed,
    failed: metrics.failed,
    skipped: metrics.skipped,
    cancelled: metrics.cancelled,
    pending: metrics.pending,
    running: metrics.running,
    cancelledByRequest: record.cancelRequestedAt !== null,
    budgetStop: options.budgetStop,
  });

  // A deliberate pause wins over "running": the orchestrator stopped on purpose,
  // so a settle pass must not flip the status back.
  const nextStatus: ExperimentStatus =
    status === "RUNNING" && record.pausedAt !== null ? "PAUSED" : status;

  if (record.status !== nextStatus) {
    assertExperimentTransition(record.status, nextStatus);
  }
  await experimentRepository.updateStatus(experimentId, {
    status: nextStatus,
    // Terminal means terminal: a budget-capped or cancelled experiment keeps
    // unexecuted cases, but its finish time is still the moment it settled.
    completedAt:
      isTerminalExperimentStatus(nextStatus) && record.completedAt === null
        ? new Date()
        : record.completedAt,
  });

  serviceLogger.info("experiment settled", {
    experimentId,
    status: nextStatus,
    completed: metrics.completed,
    failed: metrics.failed,
    cancelled: metrics.cancelled,
    pending: metrics.pending,
    budgetStop: options.budgetStop,
  });

  return experimentRepository.findById(experimentId);
}

/** Refreshes stored metrics without touching the status (used between passes). */
export async function refreshExperimentMetrics(experimentId: string): Promise<ExperimentRecord | null> {
  const record = await experimentRepository.findById(experimentId);
  if (record === null) {
    return null;
  }
  const loaded = await loadExperiment(record);
  await experimentRepository.saveMetrics(experimentId, loaded.experimentMetrics);
  return experimentRepository.findById(experimentId);
}

export { metricsAreStale };

// ------------------------------------------------------------------------------
// Selection and promotion
// ------------------------------------------------------------------------------

export interface SelectionResult {
  experiment: ExperimentRecord;
  candidate: ExperimentCandidateRecord;
  authorization: ExperimentAuthorizationReport;
  warnings: string[];
}

/**
 * Records which candidate the author selected (or recommends), with the evidence
 * that was on screen: constraint status, evaluator coverage, evidence quality.
 * Warnings are *returned*, not enforced — selecting a candidate is a judgement
 * call, and the service's job is to make the trade-offs explicit, not to hide
 * them.
 */
export async function selectCandidate(
  user: AuthUser,
  experimentId: string,
  body: SelectCandidateBody,
): Promise<SelectionResult> {
  const record = await requireExperiment(user, experimentId);
  const candidate = await experimentRepository.findCandidate(experimentId, body.candidateId);
  if (candidate === null) {
    throw new NotFoundError("Candidate not found in this experiment");
  }
  if (record.status === "DRAFT") {
    throw new ExperimentSelectionError(
      "This experiment has not run yet, so there is no evidence to select a candidate from.",
    );
  }

  const loaded = await loadExperiment(record);
  const analysis =
    buildCandidateAnalyses({
      experiment: loaded.experiment,
      candidates: loaded.candidates,
      byCandidate: loaded.byCandidate,
    }).get(candidate.id) ?? null;

  const authorization = verifyExperimentAuthorization({
    candidate,
    metrics: loaded.byCandidate.get(candidate.id)?.metrics ?? null,
    constraints: record.constraints,
    passThreshold: record.passThreshold,
    experimentStatus: record.status,
    settled: loaded.progress.pending === 0 && loaded.progress.running === 0,
    evidenceVerdict: analysis?.evidence.verdict ?? null,
    pairedCases: analysis === null ? null : pairedCasesOf(analysis),
  });

  await experimentRepository.setSelection(experimentId, {
    candidateId: candidate.id,
    kind: body.kind,
    notes: body.notes ?? null,
    userId: user.id,
  });

  serviceLogger.info("experiment candidate selected", {
    experimentId,
    candidateId: candidate.id,
    kind: body.kind,
    warnings: authorization.warnings.length,
    userId: user.id,
  });
  const refreshed = await experimentRepository.findById(experimentId);
  return {
    experiment: refreshed ?? record,
    candidate,
    authorization,
    warnings: authorization.warnings,
  };
}

function pairedCasesOf(analysis: CandidateAnalysis): number {
  return analysis.paired.filter((entry) => entry.difference !== null).length;
}

export interface PromotionResult {
  experiment: ExperimentRecord;
  candidate: ExperimentCandidateRecord;
  harnessVersion: { id: string; version: number; harnessId: string };
  promotedFrom: number;
  warnings: string[];
}

/**
 * Promotes a candidate's immutable harness version.
 *
 * The advancement itself is delegated to `promoteHarnessVersion`, so the harness
 * keeps exactly one promotion rule: forward-only (a promotion can never roll a
 * harness back) and gated by the winning batch's pass rate. This service only
 * adds the experiment-specific gates — see `evaluatePromotionGates` — and records
 * the decision, with its warnings, on the experiment.
 */
export async function promoteCandidate(
  user: AuthUser,
  experimentId: string,
  body: PromoteCandidateBody,
): Promise<PromotionResult> {
  const record = await requireExperiment(user, experimentId);
  if (!isTerminalExperimentStatus(record.status)) {
    throw new ExperimentPromotionError(
      `Promotion needs a settled experiment; this one is ${record.status.toLowerCase()}.`,
    );
  }

  const targetId = body.candidateId ?? record.selectedCandidateId;
  if (targetId === null) {
    throw new ExperimentPromotionError(
      "Select a candidate first (or pass candidateId) — promotion never picks a winner on its own.",
    );
  }
  const candidate = await experimentRepository.findCandidate(experimentId, targetId);
  if (candidate === null) {
    throw new NotFoundError("Candidate not found in this experiment");
  }

  const loaded = await loadExperiment(record);
  const analysis =
    buildCandidateAnalyses({
      experiment: loaded.experiment,
      candidates: loaded.candidates,
      byCandidate: loaded.byCandidate,
    }).get(candidate.id) ?? null;

  const settled = loaded.progress.pending === 0 && loaded.progress.running === 0;
  const metrics = loaded.byCandidate.get(candidate.id)?.metrics ?? null;
  const primaryReplicate = candidate.replicates[0] ?? null;

  const gates = evaluatePromotionGates({
    experimentStatus: record.status,
    settled,
    selectedCandidateId: record.selectedCandidateId,
    candidate,
    metrics,
    constraints: record.constraints,
    primaryReplicateBatchId: primaryReplicate?.evaluationBatchId ?? null,
    evidenceVerdict: analysis?.evidence.verdict ?? null,
    pairedCases: analysis === null ? null : pairedCasesOf(analysis),
  });

  if (!gates.allowed) {
    throw new ExperimentPromotionError(
      `This candidate cannot be promoted: ${gates.blockers.join(" ")}`,
    );
  }
  const warnings = [...gates.warnings];
  if (analysis !== null && analysis.regressions.length > 0) {
    warnings.push(`${analysis.regressions.length} case(s) regressed against the baseline.`);
  }
  if (analysis !== null && analysis.pathChanges.length > 0) {
    warnings.push(
      `${analysis.pathChanges.length} case(s) ran a different execution path than the baseline.`,
    );
  }

  const promotion = await promoteHarnessVersion(user, candidate.harnessId, {
    batchId: primaryReplicate!.evaluationBatchId,
    ...(body.passRateThreshold !== undefined ? { passRateThreshold: body.passRateThreshold } : {}),
  });

  const promotionNotes = [
    body.notes ?? null,
    ...warnings.map((warning) => `Warning: ${warning}`),
  ]
    .filter((entry): entry is string => entry !== null)
    .join("\n");

  await experimentRepository.setPromotion(experimentId, {
    candidateId: candidate.id,
    notes: promotionNotes === "" ? null : promotionNotes,
    userId: user.id,
  });

  serviceLogger.info("experiment candidate promoted", {
    experimentId,
    candidateId: candidate.id,
    harnessId: candidate.harnessId,
    harnessVersion: promotion.harnessVersion.version,
    promotedFrom: promotion.promotedFrom,
    warnings: warnings.length,
    userId: user.id,
  });

  const refreshed = await experimentRepository.findById(experimentId);
  return {
    experiment: refreshed ?? record,
    candidate,
    harnessVersion: {
      id: promotion.harnessVersion.id,
      version: promotion.harnessVersion.version,
      harnessId: candidate.harnessId,
    },
    promotedFrom: promotion.promotedFrom,
    warnings,
  };
}

// ------------------------------------------------------------------------------
// Export
// ------------------------------------------------------------------------------

export interface ExperimentExport {
  fileName: string;
  contentType: string;
  body: string;
}

/**
 * Builds the export. Every free-form value passes through `sanitizeValue`, so a
 * stored error or an evaluator's evidence (which may quote agent output) cannot
 * carry a credential out of the platform. No credential is ever stored in an
 * experiment snapshot, so the configuration section is exported verbatim.
 */
export async function exportExperiment(
  user: AuthUser,
  experimentId: string,
  query: ExportExperimentQuery,
): Promise<ExperimentExport> {
  const record = await requireExperiment(user, experimentId);
  const loaded = await loadExperiment(record);
  const analyses = buildCandidateAnalyses({
    experiment: loaded.experiment,
    candidates: loaded.candidates,
    byCandidate: loaded.byCandidate,
  });
  const ranking = rankLoaded({
    experiment: loaded.experiment,
    candidates: loaded.candidates,
    byCandidate: loaded.byCandidate,
    analyses,
  });

  const rows =
    query.candidateId === undefined
      ? loaded.rows
      : loaded.rows.filter((row) => row.candidateId === query.candidateId);

  if (query.format === "csv") {
    return {
      fileName: `experiment-${experimentId.slice(-6)}-cases.csv`,
      contentType: "text/csv; charset=utf-8",
      body: buildCsv({ record, candidates: loaded.candidates, rows }),
    };
  }

  const report = {
    schemaVersion: 1,
    kind: "orqestra.experiment-report",
    exportedAt: new Date().toISOString(),
    sanitized: true,
    experiment: {
      id: record.id,
      name: record.name,
      description: record.description,
      hypothesis: record.hypothesis,
      status: record.status,
      createdAt: record.createdAt.toISOString(),
      startedAt: record.startedAt?.toISOString() ?? null,
      completedAt: record.completedAt?.toISOString() ?? null,
      cancelRequestedAt: record.cancelRequestedAt?.toISOString() ?? null,
      pausedAt: record.pausedAt?.toISOString() ?? null,
      passThreshold: record.passThreshold,
      scoringPolicy: record.scoringPolicy,
    },
    /** The configuration exactly as sealed at launch. */
    configurationSnapshot: record.configSnapshot,
    objective: record.objective,
    constraints: record.constraints,
    execution: record.execution,
    evaluators: record.evaluatorConfig.map((assignment) => ({
      key: assignment.key,
      name: assignment.name,
      kind: assignment.kind,
      version: assignment.evaluatorVersion,
      weight: assignment.weight,
      usesLlm: assignment.usesLlm,
    })),
    candidates: loaded.candidates.map((candidate) => {
      const metrics = loaded.byCandidate.get(candidate.id)?.metrics ?? null;
      const analysis = analyses.get(candidate.id) ?? null;
      const entry = ranking.candidates.find((item) => item.metrics.candidateId === candidate.id);
      return {
        id: candidate.id,
        label: candidate.label,
        role: candidate.role,
        hypothesis: candidate.hypothesis,
        harness: candidate.harnessSnapshot,
        replicateBatchIds: candidate.replicates.map((replicate) => replicate.evaluationBatchId),
        metrics,
        constraints: entry?.constraints ?? null,
        primary: analysis?.primary ?? null,
        secondary: analysis?.secondary ?? [],
        evidence: analysis?.evidence ?? null,
        caseMovement: analysis?.caseMovement ?? null,
        regressions: sanitizeValue(analysis?.regressions ?? []),
        pathChanges: sanitizeValue(analysis?.pathChanges ?? []),
        rank: entry?.rank ?? null,
        eligibleForWin: entry?.eligibleForWin ?? false,
        winBlockers: entry?.winBlockers ?? [],
        reasons: entry?.reasons ?? [],
      };
    }),
    ranking: {
      leader: ranking.leader,
      leaderNote: ranking.leaderNote,
      settled: ranking.settled,
      notes: ranking.notes,
    },
    selection: {
      candidateId: record.selectedCandidateId,
      kind: record.selectionKind,
      notes: record.selectionNotes,
      selectedBy: record.selectedBy,
      selectedAt: record.selectedAt?.toISOString() ?? null,
    },
    promotion: {
      candidateId: record.promotedCandidateId,
      notes: record.promotionNotes,
      promotedBy: record.promotedBy,
      promotedAt: record.promotedAt?.toISOString() ?? null,
    },
    cases: rows.map((row) => {
      const candidate = loaded.candidates.find((entry) => entry.id === row.candidateId);
      return {
        candidateId: row.candidateId,
        candidateLabel: candidate?.label ?? null,
        replicate: row.replicate,
        caseKey: row.caseKey,
        caseIndex: row.index,
        status: row.status,
        runId: row.runId,
        score: row.aggregateScore,
        aggregateStatus: row.aggregateStatus,
        passed: row.passed,
        latencyMs: row.latencyMs,
        totalTokens: row.totalTokens,
        estimatedCostUsd: estimateUsageCost(row.usage).costUsd,
        toolCalls: row.toolCalls,
        attempts: row.attempt,
        error: sanitizeValue(row.error),
        results: row.results.map((result) => ({
          evaluatorKey: result.evaluatorKey,
          evaluatorName: result.evaluatorName,
          kind: result.kind,
          status: result.status,
          score: result.score,
          maxScore: result.maxScore,
          normalizedScore: result.normalizedScore,
          passed: result.passed,
          explanation: result.explanation,
          durationMs: result.durationMs,
          evidence: sanitizeValue(result.evidence),
        })),
      };
    }),
    reproducibility: {
      notes: record.configSnapshot?.reproducibilityNotes ?? [],
      engineVersion: record.configSnapshot?.runtimeEngineVersion ?? null,
      pricingVersion: record.configSnapshot?.pricingVersion ?? null,
    },
  };

  return {
    fileName: `experiment-${experimentId.slice(-6)}.json`,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(report, null, 2),
  };
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  const text = typeof value === "string" ? value : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One row per case execution; evaluator verdicts are flattened into columns. */
function buildCsv(input: {
  record: ExperimentRecord;
  candidates: ExperimentCandidateRecord[];
  rows: ExperimentCaseMetricRow[];
}): string {
  const evaluatorKeys = input.record.evaluatorConfig.map((assignment) => assignment.key);
  const header = [
    "experiment",
    "candidate",
    "role",
    "harness_version",
    "replicate",
    "case_key",
    "case_index",
    "status",
    "score",
    "aggregate_status",
    "passed",
    "run_id",
    "latency_ms",
    "total_tokens",
    "estimated_cost_usd",
    "tool_calls",
    "attempts",
    ...evaluatorKeys.map((key) => `eval:${key}`),
  ];

  const lines = [header.map(csvCell).join(",")];
  for (const row of input.rows) {
    const candidate = input.candidates.find((entry) => entry.id === row.candidateId);
    const byKey = new Map(row.results.map((result) => [result.evaluatorKey, result]));
    lines.push(
      [
        input.record.name,
        candidate?.label ?? row.candidateId,
        candidate?.role ?? "",
        candidate?.harnessVersion ?? "",
        row.replicate,
        row.caseKey,
        row.index,
        row.status,
        row.aggregateScore,
        row.aggregateStatus,
        row.passed,
        row.runId,
        row.latencyMs,
        row.totalTokens,
        estimateUsageCost(row.usage).costUsd,
        row.toolCalls,
        row.attempt,
        ...evaluatorKeys.map((key) => {
          const result = byKey.get(key);
          if (result === undefined) {
            return "";
          }
          return `${result.status}:${result.normalizedScore ?? ""}`;
        }),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}
