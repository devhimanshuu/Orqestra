/**
 * Optimization service — the only entry point for optimization operations.
 *
 * Authorization chain (never trusting client ids):
 *   user → workspace → project → agent → harness version / evaluation batch
 *
 * The two rules that shape everything else:
 *
 *  1. **The baseline is the evidence batch's own version.** A session is only
 *     meaningful if the candidate is measured against the metrics the baseline
 *     actually produced, so `baselineVersionId` must be the version the source
 *     batch ran. Anything else would compare a candidate to a number that came
 *     from somewhere else.
 *  2. **Nothing here executes the loop.** Creating, updating and reviewing write
 *     rows; the worker's orchestrator does the analysis, mutation, evaluation and
 *     decisions. This module resolves configuration, enforces authorization and
 *     budget ceilings, records human decisions, and assembles read models.
 */

import type { AuthUser } from "@/lib/auth/provider";
import { NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logging/logger";
import { assertAgentAccess, assertHarnessAccess, assertProjectAccess } from "@/modules/access/access.service";
import type { Agent } from "@/modules/agents/agent.types";
import type { EvaluationBatchRecord } from "@/modules/evaluation/batch.types";
import { isTerminalBatchStatus } from "@/modules/evaluation/batch.types";
import { datasetRepository } from "@/modules/evaluation/dataset.repository";
import { evaluationRepository } from "@/modules/evaluation/evaluation.repository";
import { sanitizeValue } from "@/modules/evaluation/sanitize";
import { harnessRepository } from "@/modules/harness/harness.repository";
import { promoteHarnessVersion } from "@/modules/harness/harness.service";
import { validateHarnessDefinition } from "@/modules/harness/harness.validation";
import type { Harness, HarnessVersion } from "@/modules/harness/harness.types";
import { listProjects } from "@/modules/projects/project.service";
import type { Project } from "@/modules/projects/project.types";
import { requestRunCancellation } from "@/modules/runtime/events/bus";
import { dispatchOptimization, type OptimizationDispatchResult } from "./jobs/dispatcher";
import { buildConfigSnapshot } from "./jobs/orchestrator";
import {
  verifyOptimizationPromotion,
  verifyOptimizationReview,
  type OptimizationPromotionReport,
  type OptimizationReviewReport,
} from "./optimization.authorization";
import {
  assertOptimizationTransition,
  isCancellableOptimizationStatus,
  isResumableOptimizationStatus,
  isStartableOptimizationStatus,
} from "./optimization.lifecycle";
import { optimizationRepository } from "./optimization.repository";
import {
  DEFAULT_OPTIMIZATION_LIMITS,
  EMPTY_OPTIMIZATION_CONSTRAINTS,
  OptimizationCandidateNotFoundError,
  OptimizationConflictError,
  OptimizationPromotionError,
  OptimizationValidationError,
} from "./optimization.types";
import type {
  FailureFindingRecord,
  HarnessMutationRecord,
  ImprovementHypothesisRecord,
  OptimizationCandidateRecord,
  OptimizationConstraints,
  OptimizationEventRecord,
  OptimizationLimits,
  OptimizationListItem,
  OptimizationObjective,
  OptimizationOverview,
  OptimizationReport,
  OptimizationSessionRecord,
  OptimizationStats,
  OptimizationStatus,
  StopReason,
} from "./optimization.types";
import {
  buildOptimizationHistory,
  toHistoryFacts,
  type OptimizationHistory,
} from "./history/history";
import { buildOptimizationReport, renderOptimizationReportMarkdown } from "./reporting/report";
import { rankOptimizationCandidates, type RankingResult } from "./scoring/ranking";
import type {
  AttachManualCandidateBody,
  CreateOptimizationSessionBody,
  OptimizationConstraintsInput,
  OptimizationLimitsInput,
  OptimizationObjectiveInput,
  UpdateOptimizationSessionBody,
} from "./optimization.inputs";
import {
  MAX_CANDIDATES_PER_ITERATION,
  MAX_OPTIMIZATION_ITERATIONS,
  MAX_SESSION_CANDIDATES,
  MAX_SESSION_RUNS,
} from "./optimization.inputs";

const serviceLogger = logger.child({ module: "optimization" });

/** The primary metric a session optimizes when the caller names none. */
const DEFAULT_OBJECTIVE: OptimizationObjective = {
  primary: { metric: "pass_rate", direction: "maximize" },
  secondary: [{ metric: "estimated_cost_usd", direction: "minimize" }],
  minImprovementPct: 0,
  notes: null,
};

// ------------------------------------------------------------------------------
// Configuration resolution
// ------------------------------------------------------------------------------

export interface ResolvedOptimizationConfiguration {
  project: Project;
  agent: Agent;
  harness: Harness;
  baselineVersion: HarnessVersion;
  batch: EvaluationBatchRecord;
  datasetName: string;
  /** The pinned dataset version's number (0 when the row is gone). */
  datasetVersionNumber: number;
  /** Cases the candidates will be evaluated over. */
  caseCount: number;
}

export interface OptimizationPlan {
  configuration: {
    project: { id: string; name: string };
    agent: { id: string; name: string };
    harness: { id: string; name: string; slug: string; currentVersion: number };
    baseline: { harnessVersionId: string; version: number; contentHash: string; nodeCount: number; edgeCount: number; entryNode: string };
    sourceBatch: { id: string; label: string | null; status: string; caseCount: number; datasetVersionId: string };
    dataset: { id: string; name: string; version: number };
    caseCount: number;
    evaluators: number;
    scoringPolicy: string;
    passThreshold: number | null;
    objective: OptimizationObjective;
    constraints: OptimizationConstraints;
    limits: OptimizationLimits;
    strategy: string;
  };
  volume: {
    caseCount: number;
    maxIterations: number;
    maxCandidates: number;
    /** Runs one candidate evaluation costs. */
    runsPerCandidate: number;
    /** Runs the whole session may cost at its ceilings. */
    plannedRuns: number;
    maxRuns: number;
    exceedsRunBudget: boolean;
  };
  checks: Array<{ level: "ok" | "warning" | "error"; message: string }>;
  lines: { objective: string[]; constraints: string[]; notes: string[] };
  warnings: string[];
  valid: boolean;
  issues: Array<{ path: string; message: string }>;
}

function resolveObjective(
  input: OptimizationObjectiveInput | undefined,
): OptimizationObjective {
  if (input === undefined) {
    return DEFAULT_OBJECTIVE;
  }
  return {
    primary: input.primary,
    secondary: input.secondary,
    minImprovementPct: input.minImprovementPct,
    notes: input.notes,
  };
}

function resolveConstraints(input: OptimizationConstraintsInput | undefined): OptimizationConstraints {
  if (input === undefined) {
    return EMPTY_OPTIMIZATION_CONSTRAINTS;
  }
  return { ...input };
}

/** Clamps a requested limit set against the platform ceilings. */
function resolveLimits(input: OptimizationLimitsInput | undefined): OptimizationLimits {
  const requested = { ...DEFAULT_OPTIMIZATION_LIMITS, ...(input ?? {}) };
  return {
    ...requested,
    maxIterations: Math.min(requested.maxIterations, MAX_OPTIMIZATION_ITERATIONS),
    maxCandidatesPerIteration: Math.min(
      requested.maxCandidatesPerIteration,
      MAX_CANDIDATES_PER_ITERATION,
    ),
    maxCandidates: Math.min(requested.maxCandidates, MAX_SESSION_CANDIDATES),
    maxRuns: Math.min(requested.maxRuns, MAX_SESSION_RUNS),
  };
}

/**
 * Resolves every identifier a session pins, through the membership chain, and
 * reports what is wrong (rather than throwing) so the plan endpoint can show it.
 */
async function resolveConfiguration(
  user: AuthUser,
  input: {
    projectId: string;
    agentId: string;
    baselineVersionId: string;
    sourceBatchId: string;
  },
): Promise<{ resolved: ResolvedOptimizationConfiguration | null; issues: Array<{ path: string; message: string }>; warnings: string[] }> {
  const issues: Array<{ path: string; message: string }> = [];
  const warnings: string[] = [];

  const project = await assertProjectAccess(user.id, input.projectId).catch(() => null);
  if (project === null) {
    return {
      resolved: null,
      issues: [{ path: "projectId", message: "Project not found or not accessible." }],
      warnings,
    };
  }
  const agent = await assertAgentAccess(user.id, input.agentId).catch(() => null);
  if (agent === null) {
    issues.push({ path: "agentId", message: "Agent not found or not accessible." });
  } else if (agent.projectId !== project.id) {
    issues.push({ path: "agentId", message: "That agent belongs to a different project." });
  }

  const baselineVersion = await harnessRepository.findVersionById(input.baselineVersionId);
  if (baselineVersion === null) {
    issues.push({ path: "baselineVersionId", message: "Harness version not found." });
  }
  const harness =
    baselineVersion === null ? null : await assertHarnessAccess(user.id, baselineVersion.harnessId).catch(() => null);
  if (baselineVersion !== null && harness === null) {
    issues.push({ path: "baselineVersionId", message: "Harness not found or not accessible." });
  }

  const batch = await evaluationRepository.findById(input.sourceBatchId);
  if (batch === null) {
    issues.push({ path: "sourceBatchId", message: "Evaluation batch not found." });
  }

  if (
    project === null ||
    agent === null ||
    harness === null ||
    baselineVersion === null ||
    batch === null ||
    issues.length > 0
  ) {
    return { resolved: null, issues, warnings };
  }

  if (harness.projectId !== project.id) {
    issues.push({ path: "baselineVersionId", message: "That harness belongs to a different project." });
  }
  if (harness.agentId !== null && harness.agentId !== agent.id) {
    issues.push({ path: "baselineVersionId", message: "That harness belongs to a different agent." });
  }
  if (batch.projectId !== project.id) {
    issues.push({ path: "sourceBatchId", message: "That evaluation batch belongs to a different project." });
  }
  if (batch.agentId !== agent.id) {
    issues.push({ path: "sourceBatchId", message: "That evaluation batch ran a different agent." });
  }
  if (batch.harnessId !== harness.id) {
    issues.push({ path: "sourceBatchId", message: "That evaluation batch ran a different harness." });
  }
  // The comparison is only meaningful when the metrics used as the baseline came
  // from the version the candidates are being compared against.
  if (batch.harnessVersionId !== baselineVersion.id) {
    issues.push({
      path: "baselineVersionId",
      message:
        "The baseline must be the harness version the source batch ran — otherwise the comparison is against another version's numbers.",
    });
  }
  if (!isTerminalBatchStatus(batch.status)) {
    issues.push({
      path: "sourceBatchId",
      message: `That evaluation batch is ${batch.status.toLowerCase()}; wait for it to settle before optimizing on it.`,
    });
  }
  const caseCount = batch.datasetSnapshot.length;
  if (caseCount === 0) {
    issues.push({ path: "sourceBatchId", message: "That evaluation batch executed no cases." });
  }
  const datasetVersion = await datasetRepository.findVersionById(batch.datasetVersionId);
  if (datasetVersion === null) {
    issues.push({ path: "sourceBatchId", message: "The batch's dataset version no longer exists." });
  }
  if (batch.metrics === null) {
    warnings.push(
      "The source batch has no computed metrics yet, so candidates can be evaluated but not compared against a baseline.",
    );
  }
  if (batch.evaluatorConfig.length === 0) {
    warnings.push("The source batch recorded no evaluators; candidates will be judged on the pass rule alone.");
  }
  const dataset = await datasetRepository.findById(batch.datasetId);

  return {
    resolved: {
      project,
      agent,
      harness,
      baselineVersion,
      batch,
      datasetName: dataset?.name ?? "Dataset",
      datasetVersionNumber: datasetVersion?.version ?? 0,
      caseCount,
    },
    issues,
    warnings,
  };
}

function toPlanLines(objective: OptimizationObjective, constraints: OptimizationConstraints): OptimizationPlan["lines"] {
  const objectiveLines = [
    `Primary: ${objective.primary.metric} (${objective.primary.direction})`,
    ...objective.secondary.map((spec) => `Secondary: ${spec.metric} (${spec.direction})`),
    objective.minImprovementPct > 0
      ? `A candidate must improve the primary metric by at least ${(objective.minImprovementPct * 100).toFixed(1)}%.`
      : "Any measured improvement on the primary metric counts as a win.",
  ];
  const constraintLines: string[] = [];
  const entries: Array<[string, number | null]> = [
    ["Minimum pass rate", constraints.minPassRate],
    ["Minimum mean score", constraints.minMeanScore],
    ["Maximum median latency (ms)", constraints.maxMedianLatencyMs],
    ["Maximum total tokens", constraints.maxTotalTokens],
    ["Maximum total cost (USD)", constraints.maxTotalCostUsd],
    ["Maximum cost increase over baseline", constraints.maxCostIncreasePct],
    ["Maximum latency increase over baseline", constraints.maxLatencyIncreasePct],
    ["Maximum quality regression", constraints.maxQualityRegressionPct],
  ];
  for (const [label, value] of entries) {
    if (value !== null) {
      constraintLines.push(`${label}: ${value}`);
    }
  }
  if (constraintLines.length === 0) {
    constraintLines.push("No hard constraints — the objective alone decides.");
  }
  return { objective: objectiveLines, constraints: constraintLines, notes: [] };
}

/** Pre-flight for a configuration that may not be stored yet. */
export async function planOptimization(
  user: AuthUser,
  body: CreateOptimizationSessionBody,
): Promise<OptimizationPlan> {
  const { resolved, issues, warnings } = await resolveConfiguration(user, {
    projectId: body.projectId,
    agentId: body.agentId,
    baselineVersionId: body.baselineVersionId,
    sourceBatchId: body.sourceBatchId,
  });

  const objective = resolveObjective(body.objective);
  const constraints = resolveConstraints(body.constraints);
  const limits = resolveLimits(body.limits);
  const lines = toPlanLines(objective, constraints);

  if (resolved === null) {
    return {
      configuration: placeholderConfiguration(objective, constraints, limits, body.strategy),
      volume: placeholderVolume(limits),
      checks: issues.map((issue) => ({ level: "error" as const, message: `${issue.path}: ${issue.message}` })),
      lines,
      warnings,
      valid: false,
      issues,
    };
  }

  const definition = resolved.baselineVersion.definition;
  const runsPerCandidate = resolved.caseCount;
  const plannedRuns =
    runsPerCandidate * Math.min(limits.maxCandidates, limits.maxIterations * limits.maxCandidatesPerIteration);
  if (resolved.caseCount > limits.maxRuns) {
    issues.push({
      path: "limits.maxRuns",
      message: `The run budget (${limits.maxRuns}) cannot cover a single candidate evaluation of ${resolved.caseCount} case(s).`,
    });
  }
  if (!Number.isFinite(plannedRuns) || plannedRuns > limits.maxRuns) {
    warnings.push(
      `The configured ceilings allow up to ${plannedRuns} run(s) against a budget of ${limits.maxRuns}; the loop stops at whichever comes first.`,
    );
  }
  if (limits.requireApprovalBeforeEvaluation) {
    warnings.push("Each candidate is parked for human approval before it is evaluated.");
  }
  if (limits.analyzerModel !== null) {
    warnings.push(
      `The LLM-assisted strategy may call ${limits.analyzerModel} to propose changes; its usage is accounted separately from agent runs.`,
    );
  }

  const checks: OptimizationPlan["checks"] = issues.map((issue) => ({
    level: "error" as const,
    message: `${issue.path}: ${issue.message}`,
  }));
  for (const warning of warnings) {
    checks.push({ level: "warning", message: warning });
  }
  if (issues.length === 0) {
    checks.unshift({
      level: "ok",
      message:
        warnings.length === 0
          ? "The configuration is runnable exactly as specified."
          : "No blocking problems were found; the notes below describe what the configuration does and does not prove.",
    });
  }

  return {
    configuration: {
      project: { id: resolved.project.id, name: resolved.project.name },
      agent: { id: resolved.agent.id, name: resolved.agent.name },
      harness: {
        id: resolved.harness.id,
        name: resolved.harness.name,
        slug: resolved.harness.slug,
        currentVersion: resolved.harness.currentVersion,
      },
      baseline: {
        harnessVersionId: resolved.baselineVersion.id,
        version: resolved.baselineVersion.version,
        contentHash: resolved.baselineVersion.contentHash,
        nodeCount: definition.nodes.length,
        edgeCount: definition.edges.length,
        entryNode: resolved.baselineVersion.entryNode,
      },
      sourceBatch: {
        id: resolved.batch.id,
        label: resolved.batch.label,
        status: resolved.batch.status,
        caseCount: resolved.batch.caseCount,
        datasetVersionId: resolved.batch.datasetVersionId,
      },
      dataset: {
        id: resolved.batch.datasetId,
        name: resolved.datasetName,
        version: resolved.datasetVersionNumber,
      },
      caseCount: resolved.caseCount,
      evaluators: resolved.batch.evaluatorConfig.length,
      scoringPolicy: resolved.batch.scoringPolicy,
      passThreshold: resolved.batch.passThreshold,
      objective,
      constraints,
      limits,
      strategy: body.strategy,
    },
    volume: {
      caseCount: resolved.caseCount,
      maxIterations: limits.maxIterations,
      maxCandidates: limits.maxCandidates,
      runsPerCandidate,
      plannedRuns,
      maxRuns: limits.maxRuns,
      exceedsRunBudget: plannedRuns > limits.maxRuns,
    },
    checks,
    lines,
    warnings,
    valid: issues.length === 0,
    issues,
  };
}

function placeholderConfiguration(
  objective: OptimizationObjective,
  constraints: OptimizationConstraints,
  limits: OptimizationLimits,
  strategy: string,
): OptimizationPlan["configuration"] {
  return {
    project: { id: "", name: "" },
    agent: { id: "", name: "" },
    harness: { id: "", name: "", slug: "", currentVersion: 0 },
    baseline: { harnessVersionId: "", version: 0, contentHash: "", nodeCount: 0, edgeCount: 0, entryNode: "" },
    sourceBatch: { id: "", label: null, status: "", caseCount: 0, datasetVersionId: "" },
    dataset: { id: "", name: "", version: 0 },
    caseCount: 0,
    evaluators: 0,
    scoringPolicy: "REQUIRE_ALL",
    passThreshold: null,
    objective,
    constraints,
    limits,
    strategy,
  };
}

function placeholderVolume(limits: OptimizationLimits): OptimizationPlan["volume"] {
  return {
    caseCount: 0,
    maxIterations: limits.maxIterations,
    maxCandidates: limits.maxCandidates,
    runsPerCandidate: 0,
    plannedRuns: 0,
    maxRuns: limits.maxRuns,
    exceedsRunBudget: false,
  };
}

// ------------------------------------------------------------------------------
// Read model
// ------------------------------------------------------------------------------

export interface OptimizationCandidateView extends OptimizationCandidateRecord {
  /** The published version number, once the candidate has a version. */
  harnessVersion: number | null;
  mutations: HarnessMutationRecord[];
  review: OptimizationReviewReport | null;
  promotion: OptimizationPromotionReport | null;
}

export interface OptimizationProgress {
  status: OptimizationStatus;
  settled: boolean;
  awaitingReview: boolean;
  currentIteration: number;
  maxIterations: number;
  candidateCount: number;
  maxCandidates: number;
  runCount: number;
  maxRuns: number;
  tokenUsage: number;
  analyzerTokenUsage: number;
  estimatedCostUsd: number;
  evaluatedCandidates: number;
  acceptedCandidates: number;
  rejectedCandidates: number;
  invalidCandidates: number;
  stopReason: string | null;
  elapsedMs: number | null;
}

export interface OptimizationDetail {
  session: OptimizationSessionRecord;
  agent: { id: string; name: string } | null;
  harness: { id: string; name: string; slug: string; currentVersion: number | null } | null;
  dataset: { id: string; name: string; version: number } | null;
  baseline: { id: string; version: number; contentHash: string } | null;
  sourceBatch: { id: string; label: string | null; status: string; caseCount: number } | null;
  findings: FailureFindingRecord[];
  hypotheses: ImprovementHypothesisRecord[];
  candidates: OptimizationCandidateView[];
  events: OptimizationEventRecord[];
  ranking: RankingResult;
  progress: OptimizationProgress;
  review: OptimizationReviewReport | null;
}

async function requireOptimization(user: AuthUser, sessionId: string): Promise<OptimizationSessionRecord> {
  const record = await optimizationRepository.findById(sessionId);
  if (record === null) {
    throw new NotFoundError("Optimization session not found");
  }
  await assertProjectAccess(user.id, record.projectId);
  return record;
}

function progressOf(
  session: OptimizationSessionRecord,
  candidates: readonly OptimizationCandidateRecord[],
): OptimizationProgress {
  const startedAt = session.startedAt;
  const endedAt = session.completedAt ?? new Date();
  return {
    status: session.status,
    settled: session.completedAt !== null,
    awaitingReview: session.status === "WAITING_FOR_REVIEW",
    currentIteration: session.currentIteration,
    maxIterations: session.maxIterations,
    candidateCount: candidates.length,
    maxCandidates: session.limits.maxCandidates,
    runCount: session.runCount,
    maxRuns: session.limits.maxRuns,
    tokenUsage: session.tokenUsage,
    analyzerTokenUsage: session.analyzerTokenUsage,
    estimatedCostUsd: session.estimatedCostUsd,
    evaluatedCandidates: candidates.filter((candidate) => candidate.metrics !== null).length,
    acceptedCandidates: candidates.filter((candidate) => candidate.decisionKind === "ACCEPT").length,
    rejectedCandidates: candidates.filter((candidate) => candidate.decisionKind === "REJECT").length,
    invalidCandidates: candidates.filter((candidate) => candidate.status === "INVALID").length,
    stopReason: session.stopReason,
    elapsedMs: startedAt === null ? null : Math.max(0, endedAt.getTime() - startedAt.getTime()),
  };
}

export async function getOptimizationSession(
  user: AuthUser,
  sessionId: string,
): Promise<OptimizationDetail> {
  const session = await requireOptimization(user, sessionId);
  const [meta, findings, hypotheses, candidates, events, baselineMetrics] = await Promise.all([
    optimizationRepository.findMeta(sessionId),
    optimizationRepository.listFindings(sessionId),
    optimizationRepository.listHypotheses(sessionId),
    optimizationRepository.listCandidates(sessionId),
    optimizationRepository.listEvents(sessionId, { limit: 200 }),
    optimizationRepository.loadBatchMetrics(session.sourceBatchId),
  ]);

  const views: OptimizationCandidateView[] = [];
  for (const candidate of candidates) {
    const [mutations, version] = await Promise.all([
      optimizationRepository.listMutations(candidate.id),
      candidate.versionId === null
        ? Promise.resolve(null)
        : harnessRepository.findVersionById(candidate.versionId),
    ]);
    views.push({
      ...candidate,
      harnessVersion: version?.version ?? null,
      mutations,
      review:
        session.status === "WAITING_FOR_REVIEW"
          ? verifyOptimizationReview({ sessionStatus: session.status, candidate })
          : null,
      promotion: verifyOptimizationPromotion({
        sessionStatus: session.status,
        candidate,
        override: false,
        overrideReason: null,
      }),
    });
  }

  const ranking = rankOptimizationCandidates({
    objective: session.objective,
    baseline: session.configSnapshot?.sourceBatch.metrics ?? baselineMetrics,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      label: candidate.label,
      status: candidate.status,
      decisionKind: candidate.decisionKind,
      metrics: candidate.metrics,
    })),
  });

  const pending = candidates.find(
    (candidate) => candidate.status === "PROPOSED" && candidate.versionId === null,
  );

  return {
    session,
    agent: meta.agent,
    harness: meta.harness === null ? null : { ...meta.harness, currentVersion: null },
    dataset: meta.dataset,
    baseline: meta.baseline,
    sourceBatch: meta.sourceBatch,
    findings,
    hypotheses,
    candidates: views,
    events: events.items,
    ranking,
    progress: progressOf(session, candidates),
    review:
      session.status === "WAITING_FOR_REVIEW" && pending !== undefined
        ? verifyOptimizationReview({ sessionStatus: session.status, candidate: pending })
        : null,
  };
}

export async function listOptimizationEvents(
  user: AuthUser,
  sessionId: string,
  query: { limit?: number; offset?: number },
): Promise<{ items: OptimizationEventRecord[]; total: number }> {
  await requireOptimization(user, sessionId);
  return optimizationRepository.listEvents(sessionId, query);
}

export async function listOptimizationCandidates(
  user: AuthUser,
  sessionId: string,
  query: { status?: string[]; limit?: number; offset?: number },
): Promise<{ items: OptimizationCandidateRecord[]; total: number }> {
  await requireOptimization(user, sessionId);
  const all = await optimizationRepository.listCandidates(sessionId);
  const filtered =
    query.status === undefined || query.status.length === 0
      ? all
      : all.filter((candidate) => query.status?.includes(candidate.status) === true);
  const offset = Math.max(query.offset ?? 0, 0);
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
  return { items: filtered.slice(offset, offset + limit), total: filtered.length };
}

export async function listOptimizationSessions(
  user: AuthUser,
  query: {
    projectId?: string;
    agentId?: string;
    status?: OptimizationStatus[];
    q?: string;
    limit?: number;
    offset?: number;
  },
): Promise<{ items: OptimizationListItem[]; total: number; limit: number; offset: number }> {
  const projectIds = await scopedProjectIds(user);
  if (query.projectId !== undefined) {
    await assertProjectAccess(user.id, query.projectId);
  }
  if (query.agentId !== undefined) {
    await assertAgentAccess(user.id, query.agentId);
  }
  const scope =
    query.projectId !== undefined
      ? projectIds.filter((id) => id === query.projectId)
      : projectIds;
  if (scope.length === 0) {
    return { items: [], total: 0, limit: query.limit ?? 20, offset: query.offset ?? 0 };
  }

  const page = await optimizationRepository.list({
    projectIds: scope,
    ...(query.agentId !== undefined ? { agentId: query.agentId } : {}),
    ...(query.status !== undefined && query.status.length > 0 ? { status: query.status } : {}),
    ...(query.q !== undefined ? { q: query.q } : {}),
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
    ...(query.offset !== undefined ? { offset: query.offset } : {}),
  });

  const items: OptimizationListItem[] = page.rows.map((row) => ({
    id: row.session.id,
    name: row.session.name,
    status: row.session.status,
    agentId: row.session.agentId,
    agentName: row.agentName,
    harnessId: row.session.harnessId,
    baselineVersion: row.baselineVersion,
    strategy: row.session.strategy,
    sourceBatchId: row.session.sourceBatchId,
    datasetId: row.session.datasetId,
    datasetName: row.datasetName,
    caseCount: row.sourceBatchCaseCount,
    candidateCount: row.session.candidateCount,
    acceptedCount: row.acceptedCount,
    currentIteration: row.session.currentIteration,
    maxIterations: row.session.maxIterations,
    bestCandidateId: row.session.bestCandidateId,
    bestCandidateLabel: row.bestCandidateLabel,
    stopReason: row.session.stopReason,
    runCount: row.session.runCount,
    tokenUsage: row.session.tokenUsage,
    estimatedCostUsd: row.session.estimatedCostUsd,
    createdAt: row.session.createdAt,
    startedAt: row.session.startedAt,
    completedAt: row.session.completedAt,
  }));

  return { items, total: page.total, limit: page.limit, offset: page.offset };
}

export async function getOptimizationOverview(
  user: AuthUser,
  query: { projectId?: string; agentId?: string },
): Promise<OptimizationOverview> {
  const projectIds = await scopedProjectIds(user);
  if (query.projectId !== undefined) {
    await assertProjectAccess(user.id, query.projectId);
  }
  const scope = query.projectId !== undefined ? projectIds.filter((id) => id === query.projectId) : projectIds;

  const [stats, page] = await Promise.all([
    optimizationRepository.aggregateStats({
      projectIds: scope,
      ...(query.agentId !== undefined ? { agentId: query.agentId } : {}),
    }),
    listOptimizationSessions(user, { ...query, limit: 5 }),
  ]);

  const overview: OptimizationStats = {
    total: stats.total,
    running: (stats.byStatus["RUNNING"] ?? 0) + (stats.byStatus["QUEUED"] ?? 0),
    completed: stats.byStatus["COMPLETED"] ?? 0,
    cancelled: stats.byStatus["CANCELLED"] ?? 0,
    failed: stats.byStatus["FAILED"] ?? 0,
    improvementRate:
      stats.settledSessions === 0 ? null : stats.sessionsWithAcceptance / stats.settledSessions,
    candidateEvaluations: stats.candidateEvaluations,
    runsUsed: stats.runCount,
    estimatedCostUsd: stats.estimatedCostUsd,
  };

  return { stats: overview, recent: page.items };
}

/**
 * Cross-session history: which mutation strategies actually work, per weakness.
 *
 * Scoped exactly like the session list — the caller's projects, optionally one
 * project or agent — and derived entirely from stored rows. The aggregation
 * itself is a pure function (`buildOptimizationHistory`), so this only resolves
 * scope and reads the facts.
 */
export async function getOptimizationHistory(
  user: AuthUser,
  query: { projectId?: string; agentId?: string; since?: Date; limit?: number },
): Promise<OptimizationHistory> {
  const projectIds = await scopedProjectIds(user);
  if (query.projectId !== undefined) {
    await assertProjectAccess(user.id, query.projectId);
  }
  if (query.agentId !== undefined) {
    await assertAgentAccess(user.id, query.agentId);
  }
  const scope =
    query.projectId !== undefined ? projectIds.filter((id) => id === query.projectId) : projectIds;

  const rows = await optimizationRepository.loadHistoryFacts({
    projectIds: scope,
    ...(query.agentId !== undefined ? { agentId: query.agentId } : {}),
    ...(query.since !== undefined ? { since: query.since } : {}),
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
  });

  return buildOptimizationHistory({
    sessions: toHistoryFacts(rows),
    generatedAt: new Date(),
    filters: {
      projectId: query.projectId ?? null,
      agentId: query.agentId ?? null,
      since: query.since ?? null,
    },
  });
}

async function scopedProjectIds(user: AuthUser): Promise<string[]> {
  const projects = await listProjects(user);
  return projects.map((project) => project.id);
}

// ------------------------------------------------------------------------------
// Lifecycle
// ------------------------------------------------------------------------------

export async function createOptimizationSession(
  user: AuthUser,
  body: CreateOptimizationSessionBody,
): Promise<OptimizationDetail> {
  const objective = resolveObjective(body.objective);
  const constraints = resolveConstraints(body.constraints);
  const limits = resolveLimits(body.limits);

  const { resolved, issues, warnings } = await resolveConfiguration(user, {
    projectId: body.projectId,
    agentId: body.agentId,
    baselineVersionId: body.baselineVersionId,
    sourceBatchId: body.sourceBatchId,
  });
  if (resolved === null) {
    throw new OptimizationValidationError(
      "This optimization cannot start from the given references.",
      issues,
    );
  }
  if (resolved.caseCount > limits.maxRuns) {
    throw new OptimizationValidationError(
      `The run budget (${limits.maxRuns}) cannot cover a single candidate evaluation of ${resolved.caseCount} case(s).`,
      [{ path: "limits.maxRuns", message: "Increase maxRuns or choose a smaller dataset version." }],
    );
  }

  const session = await optimizationRepository.createSession({
    projectId: resolved.project.id,
    agentId: resolved.agent.id,
    harnessId: resolved.harness.id,
    name: body.name,
    description: body.description ?? null,
    strategy: body.strategy,
    baselineVersionId: resolved.baselineVersion.id,
    sourceBatchId: resolved.batch.id,
    datasetId: resolved.batch.datasetId,
    datasetVersionId: resolved.batch.datasetVersionId,
    evaluatorConfig: resolved.batch.evaluatorConfig,
    scoringPolicy: resolved.batch.scoringPolicy,
    passThreshold: resolved.batch.passThreshold,
    objective,
    constraints,
    limits,
    requireApproval: body.requireApproval,
    createdBy: user.id,
  });

  await optimizationRepository.appendEvent({
    sessionId: session.id,
    kind: "session.created",
    message: `Draft created against ${resolved.harness.name} v${resolved.baselineVersion.version} over ${resolved.caseCount} case(s).`,
    payload: { warnings, sourceBatchId: resolved.batch.id },
  });

  serviceLogger.info("optimization session created", {
    sessionId: session.id,
    harnessId: resolved.harness.id,
    baselineVersionId: resolved.baselineVersion.id,
    userId: user.id,
  });
  return getOptimizationSession(user, session.id);
}

export async function updateOptimizationSession(
  user: AuthUser,
  sessionId: string,
  body: UpdateOptimizationSessionBody,
): Promise<OptimizationDetail> {
  const session = await requireOptimization(user, sessionId);
  if (session.status !== "DRAFT") {
    throw new OptimizationConflictError(
      `Only a draft can be edited; this session is ${session.status.toLowerCase()} and its configuration is sealed.`,
    );
  }
  if (
    (body.baselineVersionId !== undefined && body.baselineVersionId !== session.baselineVersionId) ||
    (body.sourceBatchId !== undefined && body.sourceBatchId !== session.sourceBatchId)
  ) {
    throw new OptimizationConflictError(
      "The baseline version and the source batch are fixed when the session is created — create a new session to change them.",
    );
  }
  if (body.agentId !== undefined && body.agentId !== session.agentId) {
    throw new OptimizationConflictError("The agent of an optimization session cannot be changed.");
  }

  const limits = body.limits === undefined ? undefined : resolveLimits(body.limits);
  await optimizationRepository.updateSessionDraft(sessionId, {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.description !== undefined ? { description: body.description } : {}),
    ...(body.strategy !== undefined ? { strategy: body.strategy } : {}),
    ...(body.objective !== undefined ? { objective: resolveObjective(body.objective) } : {}),
    ...(body.constraints !== undefined ? { constraints: resolveConstraints(body.constraints) } : {}),
    ...(limits !== undefined ? { limits } : {}),
    ...(body.requireApproval !== undefined ? { requireApproval: body.requireApproval } : {}),
  });
  await optimizationRepository.appendEvent({
    sessionId,
    kind: "session.updated",
    message: "Draft configuration updated.",
  });
  return getOptimizationSession(user, sessionId);
}

/**
 * Starts (or resumes) a pass over the session.
 *
 * Starting is where the configuration is *sealed*: the snapshot is written once,
 * from the live rows, so a later edit to an evaluator, dataset or harness cannot
 * change what the session means. Resuming is the same call: the orchestrator
 * claims the session atomically, so a second pass either takes over a crashed one
 * or finds the work already claimed.
 */
export async function startOptimizationSession(
  user: AuthUser,
  sessionId: string,
): Promise<{ session: OptimizationSessionRecord; dispatch: OptimizationDispatchResult }> {
  const session = await requireOptimization(user, sessionId);
  if (!isStartableOptimizationStatus(session.status) && !isResumableOptimizationStatus(session.status)) {
    throw new OptimizationConflictError(
      `This session is ${session.status.toLowerCase()} and cannot be started again.`,
    );
  }

  let snapshot = session.configSnapshot;
  if (snapshot === null) {
    const { resolved, issues, warnings } = await resolveConfiguration(user, {
      projectId: session.projectId,
      agentId: session.agentId,
      baselineVersionId: session.baselineVersionId,
      sourceBatchId: session.sourceBatchId,
    });
    if (resolved === null) {
      throw new OptimizationValidationError(
        "This optimization can no longer resolve its baseline and evidence.",
        issues,
      );
    }
    const definition = resolved.baselineVersion.definition;
    snapshot = buildConfigSnapshot({
      session,
      baseline: {
        harnessId: resolved.harness.id,
        harnessVersionId: resolved.baselineVersion.id,
        harnessVersion: resolved.baselineVersion.version,
        contentHash: resolved.baselineVersion.contentHash,
        entryNode: resolved.baselineVersion.entryNode,
        nodeCount: definition.nodes.length,
        edgeCount: definition.edges.length,
      },
      sourceBatch: {
        batchId: resolved.batch.id,
        status: resolved.batch.status,
        caseCount: resolved.caseCount,
        completedCount: resolved.batch.completedCount,
        failedCount: resolved.batch.failedCount,
        metrics: resolved.batch.metrics,
      },
      dataset: {
        id: resolved.batch.datasetId,
        versionId: resolved.batch.datasetVersionId,
        version: resolved.datasetVersionNumber,
        caseCount: resolved.caseCount,
      },
    });
    await optimizationRepository.sealSession({
      sessionId,
      snapshot,
      status: "QUEUED",
      startedAt: session.startedAt ?? new Date(),
    });
    if (warnings.length > 0) {
      await optimizationRepository.appendEvent({
        sessionId,
        kind: "session.sealed",
        message: "Configuration sealed with notes.",
        payload: { warnings },
      });
    }
  } else {
    assertOptimizationTransition(session.status, "QUEUED");
    await optimizationRepository.updateStatus(sessionId, {
      status: "QUEUED",
      startedAt: session.startedAt ?? new Date(),
      completedAt: null,
    });
  }

  const dispatch = await dispatchOptimization(sessionId);
  await optimizationRepository.appendEvent({
    sessionId,
    kind: session.startedAt === null ? "session.started" : "session.resumed",
    message: `A ${dispatch.mode} pass was dispatched.`,
    payload: { mode: dispatch.mode, jobId: dispatch.jobId, nonce: dispatch.nonce },
  });
  serviceLogger.info("optimization session started", {
    sessionId,
    mode: dispatch.mode,
    userId: user.id,
  });

  const refreshed = await optimizationRepository.findById(sessionId);
  return { session: refreshed ?? { ...session, status: "QUEUED" }, dispatch };
}

/**
 * Requests cancellation.
 *
 * The durable flag is what the loop observes between iterations, candidates and
 * cases, so cancellation is never simulated. A session with no live pass (draft,
 * queued, or parked for review) settles immediately; a running one is settled by
 * the pass that observes the flag, which also writes its stopping report.
 */
export async function cancelOptimizationSession(
  user: AuthUser,
  sessionId: string,
  body: { reason?: string },
): Promise<{ session: OptimizationSessionRecord; runningRuns: number; settledImmediately: boolean }> {
  const session = await requireOptimization(user, sessionId);
  if (!isCancellableOptimizationStatus(session.status)) {
    throw new OptimizationConflictError(
      `This session is already ${session.status.toLowerCase()} and cannot be cancelled.`,
    );
  }

  await optimizationRepository.requestCancellation(sessionId);

  // Stop the candidate evaluation that may be in flight: its runs are cancelled
  // and its untouched cases are marked CANCELLED, so no work continues behind the
  // flag.
  const candidates = await optimizationRepository.listCandidates(sessionId);
  const batches = candidates
    .filter((candidate) => candidate.evaluationBatchId !== null && candidate.status === "EVALUATING")
    .map((candidate) => candidate.evaluationBatchId as string);
  let runningRuns = 0;
  for (const batchId of batches) {
    const page = await evaluationRepository.listCases(batchId, { status: ["RUNNING"], limit: 200 });
    for (const entry of page.cases) {
      if (entry.runId === null) {
        continue;
      }
      await requestRunCancellation(entry.runId, `optimization ${sessionId} cancelled`);
      runningRuns += 1;
    }
  }

  const livePass = session.status === "RUNNING" && runningRuns > 0;
  if (!livePass) {
    await optimizationRepository.updateStatus(sessionId, {
      status: "CANCELLED",
      completedAt: new Date(),
      stopReason: "cancelled",
    });
  }
  await optimizationRepository.appendEvent({
    sessionId,
    kind: "session.cancel_requested",
    message:
      body.reason === undefined || body.reason === ""
        ? "Cancellation requested."
        : `Cancellation requested: ${body.reason}`,
    payload: { runningRuns, settledImmediately: !livePass },
  });
  serviceLogger.info("optimization cancellation requested", {
    sessionId,
    runningRuns,
    livePass,
    userId: user.id,
  });

  const refreshed = await optimizationRepository.findById(sessionId);
  return {
    session: refreshed ?? session,
    runningRuns,
    settledImmediately: !livePass,
  };
}

// ------------------------------------------------------------------------------
// Candidate review
// ------------------------------------------------------------------------------

export async function approveOptimizationCandidate(
  user: AuthUser,
  sessionId: string,
  candidateId: string,
  body: { notes?: string },
): Promise<{ session: OptimizationSessionRecord; candidate: OptimizationCandidateRecord; dispatch: OptimizationDispatchResult | null; review: OptimizationReviewReport }> {
  const session = await requireOptimization(user, sessionId);
  const candidate = await optimizationRepository.findCandidate(sessionId, candidateId);
  if (candidate === null) {
    throw new OptimizationCandidateNotFoundError(candidateId);
  }
  const review = verifyOptimizationReview({ sessionStatus: session.status, candidate });
  if (!review.canApprove) {
    throw new OptimizationConflictError(
      `This candidate cannot be approved: ${review.blockers.join(" ")}`,
    );
  }

  await optimizationRepository.recordDecision({
    sessionId,
    candidateId: candidate.id,
    kind: "ACCEPT",
    rationale: {
      stage: "review",
      notes: body.notes ?? null,
      approvedBy: user.id,
      reasons: ["A human approved this candidate for evaluation; the change set and definition are unchanged."],
    },
    actor: user.id,
  });
  await optimizationRepository.appendEvent({
    sessionId,
    kind: "candidate.approved",
    message: `"${candidate.label}" approved for evaluation.`,
    ref: candidate.id,
  });

  // Continue the loop: the next pass publishes this exact definition and
  // evaluates it, then proposes the next candidate.
  assertOptimizationTransition(session.status, "QUEUED");
  await optimizationRepository.updateStatus(sessionId, { status: "QUEUED" });
  const dispatch = await dispatchOptimization(sessionId);
  await optimizationRepository.appendEvent({
    sessionId,
    kind: "session.resumed",
    message: `A ${dispatch.mode} pass was dispatched after the approval.`,
    payload: { mode: dispatch.mode, jobId: dispatch.jobId },
  });

  const refreshed = await optimizationRepository.findById(sessionId);
  return {
    session: refreshed ?? session,
    candidate,
    dispatch,
    review,
  };
}

export async function rejectOptimizationCandidate(
  user: AuthUser,
  sessionId: string,
  candidateId: string,
  body: { reason: string },
): Promise<{ session: OptimizationSessionRecord; candidate: OptimizationCandidateRecord; dispatch: OptimizationDispatchResult | null }> {
  const session = await requireOptimization(user, sessionId);
  const candidate = await optimizationRepository.findCandidate(sessionId, candidateId);
  if (candidate === null) {
    throw new OptimizationCandidateNotFoundError(candidateId);
  }
  const review = verifyOptimizationReview({ sessionStatus: session.status, candidate });
  if (!review.canReject) {
    throw new OptimizationConflictError(
      "Only a candidate parked for review can be rejected.",
    );
  }

  await optimizationRepository.recordDecision({
    sessionId,
    candidateId: candidate.id,
    kind: "REJECT",
    rationale: {
      stage: "review",
      notes: body.reason,
      rejectedBy: user.id,
      reasons: [`A human rejected this change: ${body.reason}`],
    },
    actor: user.id,
  });
  // The candidate must never be re-picked: it has no pending definition any more
  // and its hypothesis is spent.
  await optimizationRepository.updateCandidate(candidate.id, {
    decisionKind: "REJECT",
    clearPendingDefinition: true,
  });
  if (candidate.hypothesisId !== null) {
    await optimizationRepository.setHypothesisStatus(candidate.hypothesisId, "EXHAUSTED");
  }
  await optimizationRepository.appendEvent({
    sessionId,
    kind: "candidate.rejected_by_reviewer",
    message: `"${candidate.label}" rejected by review: ${body.reason}`,
    ref: candidate.id,
  });

  assertOptimizationTransition(session.status, "QUEUED");
  await optimizationRepository.updateStatus(sessionId, { status: "QUEUED" });
  const dispatch = await dispatchOptimization(sessionId);

  const refreshed = await optimizationRepository.findById(sessionId);
  const updated = await optimizationRepository.findCandidate(sessionId, candidateId);
  return { session: refreshed ?? session, candidate: updated ?? candidate, dispatch };
}

/**
 * Attaches a harness version the developer built by hand as a candidate.
 *
 * This is the manual strategy: no mutation engine is involved, the human authored
 * the change in the builder and published it. Attaching *is* the approval, so the
 * next pass evaluates it exactly like a proposed candidate.
 */
export async function attachManualCandidate(
  user: AuthUser,
  sessionId: string,
  body: AttachManualCandidateBody,
): Promise<{ session: OptimizationSessionRecord; candidate: OptimizationCandidateRecord }> {
  const session = await requireOptimization(user, sessionId);
  if (session.status === "COMPLETED" || session.status === "PARTIALLY_COMPLETED" || session.status === "CANCELLED" || session.status === "FAILED") {
    throw new OptimizationConflictError(
      `This session is ${session.status.toLowerCase()}; create a new session to compare another candidate.`,
    );
  }

  const version = await harnessRepository.findVersionById(body.harnessVersionId);
  if (version === null) {
    throw new NotFoundError("Harness version not found");
  }
  await assertHarnessAccess(user.id, version.harnessId);
  if (version.harnessId !== session.harnessId) {
    throw new OptimizationConflictError(
      "A manual candidate must be a version of the session's own harness.",
    );
  }

  const candidates = await optimizationRepository.listCandidates(sessionId);
  if (candidates.length >= session.limits.maxCandidates) {
    throw new OptimizationConflictError(
      `This session allows at most ${session.limits.maxCandidates} candidate(s).`,
    );
  }
  const duplicate = candidates.find((candidate) => candidate.contentHash === version.contentHash);
  if (duplicate !== undefined) {
    throw new OptimizationConflictError(
      `Version ${version.version} is already candidate "${duplicate.label}".`,
    );
  }

  const validated = validateHarnessDefinition(version.definition);
  const label = body.label ?? `${version.name} v${version.version} (manual)`;
  const candidate = await optimizationRepository.createCandidate({
    sessionId,
    iteration: session.currentIteration,
    hypothesisId: null,
    label,
    fingerprint: `manual:${version.contentHash}`,
    status: validated.ok ? "PROPOSED" : "INVALID",
    validation: {
      ok: validated.ok,
      issues: validated.issues.map((issue) => ({ code: issue.code, message: issue.message })),
      nodeCount: version.definition.nodes.length,
      edgeCount: version.definition.edges.length,
      entryNode: version.entryNode,
    },
    changeSet: [
      {
        operation: "attach_manual_candidate",
        target: `harnessVersions.${version.id}`,
        before: session.baselineVersionId,
        after: version.id,
        reason:
          body.notes ?? `Manually published version ${version.version} attached as a candidate.`,
        risk: "MEDIUM",
      },
    ],
    pendingDefinition: version.definition,
    versionId: version.id,
    contentHash: version.contentHash,
    analyzerTokenUsage: 0,
  });

  if (!validated.ok) {
    await optimizationRepository.recordDecision({
      sessionId,
      candidateId: candidate.id,
      kind: "REJECT",
      rationale: {
        stage: "validation",
        issues: validated.issues,
        reasons: ["The attached version failed graph validation."],
      },
      actor: "system",
    });
    await optimizationRepository.updateCandidate(candidate.id, {
      decisionKind: "REJECT",
      clearPendingDefinition: true,
    });
    throw new OptimizationValidationError(
      "That harness version does not validate, so it cannot be a candidate.",
      validated.issues.map((issue) => ({ path: issue.code, message: issue.message })),
    );
  }

  // Attaching is a human act: record it as the approval so the next pass picks the
  // candidate up without asking a second time.
  await optimizationRepository.recordDecision({
    sessionId,
    candidateId: candidate.id,
    kind: "ACCEPT",
    rationale: {
      stage: "manual_attach",
      notes: body.notes ?? null,
      attachedBy: user.id,
      reasons: [`Manual candidate from harness version ${version.version}.`],
    },
    actor: user.id,
  });
  await optimizationRepository.appendEvent({
    sessionId,
    kind: "candidate.attached",
    message: `Manual candidate "${label}" attached from harness version ${version.version}.`,
    ref: candidate.id,
    payload: { harnessVersionId: version.id },
  });

  serviceLogger.info("manual optimization candidate attached", {
    sessionId,
    candidateId: candidate.id,
    harnessVersionId: version.id,
    userId: user.id,
  });

  const refreshed = await optimizationRepository.findById(sessionId);
  return { session: refreshed ?? session, candidate };
}

// ------------------------------------------------------------------------------
// Promotion
// ------------------------------------------------------------------------------

export interface OptimizationPromotionResult {
  session: OptimizationSessionRecord;
  candidate: OptimizationCandidateRecord;
  harnessVersion: { id: string; version: number; harnessId: string };
  promotedFrom: number;
  warnings: string[];
  report: OptimizationPromotionReport;
}

/**
 * Promotes the session's recommended (or explicitly named) candidate.
 *
 * Promotion is the only action that changes a harness's current version, it is
 * always attributed to the caller, and it is delegated to the harness service's
 * forward-only rule. A published version is never rewritten.
 */
export async function promoteOptimizationCandidate(
  user: AuthUser,
  sessionId: string,
  body: {
    candidateId?: string;
    notes?: string;
    override?: boolean;
    reason?: string;
  },
): Promise<OptimizationPromotionResult> {
  const session = await requireOptimization(user, sessionId);

  const targetId = body.candidateId ?? session.bestCandidateId;
  if (targetId === null) {
    throw new OptimizationPromotionError(
      "No candidate is recommended yet (and none was named) — promotion never picks a winner on its own.",
    );
  }
  const candidate = await optimizationRepository.findCandidate(sessionId, targetId);
  if (candidate === null) {
    throw new OptimizationCandidateNotFoundError(targetId);
  }

  const override = body.override ?? false;
  const report = verifyOptimizationPromotion({
    sessionStatus: session.status,
    candidate,
    override,
    overrideReason: body.reason ?? null,
  });
  if (!report.allowed) {
    throw new OptimizationPromotionError(
      `This candidate cannot be promoted: ${report.blockers.join(" ")}`,
    );
  }

  // The harness service's own promotion gate is a pass-rate threshold. For an
  // optimization the evidence is the acceptance policy's verdict, but the author's
  // configured floor still applies — a session that requires a 0.8 pass rate cannot
  // promote a candidate below it, whatever the ranking says.
  const promotion = await promoteHarnessVersion(user, session.harnessId, {
    batchId: candidate.evaluationBatchId as string,
    passRateThreshold: session.constraints.minPassRate ?? 0,
  });

  await optimizationRepository.setPromotion(sessionId, {
    candidateId: candidate.id,
    notes: [...(body.notes === undefined ? [] : [body.notes]), ...report.warnings]
      .filter((entry) => entry !== "")
      .join("\n") || null,
    userId: user.id,
  });
  await optimizationRepository.recordDecision({
    sessionId,
    candidateId: candidate.id,
    kind: "ACCEPT",
    rationale: {
      stage: "promotion",
      promotedBy: user.id,
      override,
      reason: body.reason ?? null,
      warnings: report.warnings,
      reasons: [
        `Promoted "${candidate.label}" to harness version ${promotion.harnessVersion.version} (from v${promotion.promotedFrom}).`,
      ],
    },
    actor: user.id,
  });
  await optimizationRepository.appendEvent({
    sessionId,
    kind: "candidate.promoted",
    message: `"${candidate.label}" promoted: harness version ${promotion.promotedFrom} → ${promotion.harnessVersion.version}.`,
    ref: candidate.id,
    payload: {
      harnessVersionId: promotion.harnessVersion.id,
      override,
      warnings: report.warnings,
    },
  });

  serviceLogger.info("optimization candidate promoted", {
    sessionId,
    candidateId: candidate.id,
    harnessId: session.harnessId,
    harnessVersion: promotion.harnessVersion.version,
    override,
    userId: user.id,
  });

  const refreshed = await optimizationRepository.findById(sessionId);
  return {
    session: refreshed ?? session,
    candidate,
    harnessVersion: {
      id: promotion.harnessVersion.id,
      version: promotion.harnessVersion.version,
      harnessId: session.harnessId,
    },
    promotedFrom: promotion.promotedFrom,
    warnings: report.warnings,
    report,
  };
}

// ------------------------------------------------------------------------------
// Export
// ------------------------------------------------------------------------------

export interface OptimizationExport {
  fileName: string;
  contentType: string;
  body: string;
}

export async function exportOptimizationReport(
  user: AuthUser,
  sessionId: string,
  query: { format: "json" | "markdown" },
): Promise<OptimizationExport> {
  const session = await requireOptimization(user, sessionId);
  const [findings, hypotheses, candidates, baselineMetrics] = await Promise.all([
    optimizationRepository.listFindings(sessionId),
    optimizationRepository.listHypotheses(sessionId),
    optimizationRepository.listCandidates(sessionId),
    optimizationRepository.loadBatchMetrics(session.sourceBatchId),
  ]);

  const ranking = rankOptimizationCandidates({
    objective: session.objective,
    baseline: session.configSnapshot?.sourceBatch.metrics ?? baselineMetrics,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      label: candidate.label,
      status: candidate.status,
      decisionKind: candidate.decisionKind,
      metrics: candidate.metrics,
    })),
  });

  const report: OptimizationReport =
    session.report ??
    buildOptimizationReport({
      session,
      findings,
      hypotheses,
      candidates,
      baselineMetrics,
      recommendation: {
        candidateId: ranking.leader?.candidateId ?? null,
        label: ranking.leader?.label ?? null,
        rationale: ranking.note === null ? [] : [ranking.note],
      },
    });

  const base = `optimization-${session.id.slice(-6)}-${session.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  if (query.format === "markdown") {
    return {
      fileName: `${base}.md`,
      contentType: "text/markdown; charset=utf-8",
      body: renderOptimizationReportMarkdown(report),
    };
  }
  return {
    fileName: `${base}.json`,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(
      sanitizeValue({
        kind: "orqestra.optimization-export",
        exportedAt: new Date().toISOString(),
        session: {
          id: session.id,
          name: session.name,
          description: session.description,
          status: session.status,
          strategy: session.strategy,
          stopReason: session.stopReason,
          objective: session.objective,
          constraints: session.constraints,
          limits: session.limits,
          configSnapshot: session.configSnapshot,
          currentIteration: session.currentIteration,
          candidateCount: session.candidateCount,
          runCount: session.runCount,
          tokenUsage: session.tokenUsage,
          analyzerTokenUsage: session.analyzerTokenUsage,
          estimatedCostUsd: session.estimatedCostUsd,
          bestCandidateId: session.bestCandidateId,
          promotedCandidateId: session.promotedCandidateId,
          createdAt: session.createdAt,
          startedAt: session.startedAt,
          completedAt: session.completedAt,
        },
        report,
        findings,
        hypotheses,
        candidates: candidates.map((candidate) => ({
          ...candidate,
          // The definition is engineering detail the export does not need; the
          // typed change set is the auditable record of what changed.
          pendingDefinition: undefined,
        })),
        ranking,
      }),
      null,
      2,
    ),
  };
}

/** Stop reason a settled session recorded, for UI copy. */
export function describeStopReason(reason: string | null): string {
  if (reason === null) {
    return "No stopping reason recorded.";
  }
  const labels: Record<StopReason, string> = {
    max_iterations: "Stopped at the iteration limit.",
    max_candidates: "Stopped at the candidate limit.",
    max_runs: "Stopped at the run budget.",
    token_budget: "Stopped at the token budget.",
    cost_budget: "Stopped at the cost budget.",
    time_budget: "Stopped at the time budget.",
    no_hypotheses: "Stopped: no further hypothesis was available.",
    no_failures_found: "Stopped: the evidence batch showed no failures to work on.",
    no_improvement: "Stopped: no candidate improved on the baseline.",
    consecutive_invalid: "Stopped: repeated candidates failed validation.",
    cancelled: "Cancelled by a user.",
    infrastructure_failure: "Stopped by an infrastructure failure.",
    awaiting_review: "Parked for human review.",
  };
  return labels[reason as StopReason] ?? `Stopped: ${reason}.`;
}
