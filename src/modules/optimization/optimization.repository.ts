import { Prisma } from "@/generated/prisma/client";
import { getPrisma } from "@/lib/db/prisma";
import type { BatchMetrics } from "@/modules/evaluation/metrics";
import { parseBatchMetrics, parseEvaluatorAssignments } from "@/modules/evaluation/evaluation.repository";
import { parseCaseSnapshot } from "@/modules/evaluation/dataset.repository";
import type { EvaluatorAssignmentSnapshot } from "@/modules/evaluation/batch.types";
import type { CaseStatus } from "@/modules/evaluation/batch.types";
import type { AggregateStatus, ScoringPolicy } from "@/modules/evaluation/evaluation.types";
import type { DatasetCaseSnapshot } from "@/modules/evaluation/dataset.types";
import type {
  AcceptanceDecision,
  CandidateValidation,
  FailureCategory,
  FailureFindingRecord,
  FindingConfidence,
  HarnessMutationRecord,
  ImprovementHypothesisRecord,
  MutationChange,
  MutationRisk,
  OptimizationCandidateRecord,
  OptimizationCandidateStatus,
  OptimizationConfigSnapshot,
  OptimizationConstraints,
  OptimizationDecisionKind,
  OptimizationEventRecord,
  OptimizationLimits,
  OptimizationObjective,
  OptimizationReport,
  OptimizationSessionRecord,
  OptimizationStatus,
  OptimizationStrategyKind,
  SourceCaseFacts,
  TraceRef,
} from "./optimization.types";
import type { FindingDraft } from "./analysis/failure-analysis";
import type { HistorySessionRow } from "./history/history";
import type { ProposedHypothesis } from "./optimization.types";

/**
 * Optimization persistence.
 *
 * The write rules mirror the experiment layer's, for the same reasons:
 *
 *  - **Sealing is a transaction.** The configuration snapshot and the status
 *    flip are written together, so a running session always has a snapshot.
 *  - **Counters come from rows, never from a worker's memory.**
 *    `setCounters` is fed recomputed values; a crashed worker leaves an honest
 *    state that the next pass can continue from.
 *  - **Fingerprints are unique per session.** Findings, hypotheses and
 *    candidates are deduplicated in the database, so a redelivered job cannot
 *    create a second copy of the same logical row.
 *  - **The timeline is append-only.** Nothing updates or deletes an event.
 */

// --- JSON helpers --------------------------------------------------------------

function asRecord(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// --- Parsers for stored JSON ---------------------------------------------------

export function parseObjective(value: Prisma.JsonValue): OptimizationObjective {
  const record = asRecord(value) ?? {};
  const primary = asRecord(record["primary"] as Prisma.JsonValue) ?? {};
  const secondary = Array.isArray(record["secondary"]) ? record["secondary"] : [];
  return {
    primary: {
      metric: (primary["metric"] as OptimizationObjective["primary"]["metric"]) ?? "evaluation_score",
      direction: primary["direction"] === "minimize" ? "minimize" : "maximize",
    },
    secondary: secondary
      .map((entry) => asRecord(entry as Prisma.JsonValue))
      .filter((entry): entry is Record<string, unknown> => entry !== null)
      .map((entry) => ({
        metric: entry["metric"] as OptimizationObjective["primary"]["metric"],
        direction: entry["direction"] === "minimize" ? ("minimize" as const) : ("maximize" as const),
      })),
    minImprovementPct: numberOrNull(record["minImprovementPct"]) ?? 0,
    notes: stringOrNull(record["notes"]),
  };
}

export function parseConstraints(value: Prisma.JsonValue): OptimizationConstraints {
  const record = asRecord(value) ?? {};
  return {
    minPassRate: numberOrNull(record["minPassRate"]),
    minMeanScore: numberOrNull(record["minMeanScore"]),
    maxMedianLatencyMs: numberOrNull(record["maxMedianLatencyMs"]),
    maxTotalTokens: numberOrNull(record["maxTotalTokens"]),
    maxTotalCostUsd: numberOrNull(record["maxTotalCostUsd"]),
    maxCostIncreasePct: numberOrNull(record["maxCostIncreasePct"]),
    maxLatencyIncreasePct: numberOrNull(record["maxLatencyIncreasePct"]),
    maxQualityRegressionPct: numberOrNull(record["maxQualityRegressionPct"]),
  };
}

export function parseLimits(value: Prisma.JsonValue): OptimizationLimits {
  const record = asRecord(value) ?? {};
  return {
    maxIterations: numberOrNull(record["maxIterations"]) ?? 1,
    maxCandidatesPerIteration: numberOrNull(record["maxCandidatesPerIteration"]) ?? 1,
    maxCandidates: numberOrNull(record["maxCandidates"]) ?? 1,
    maxRuns: numberOrNull(record["maxRuns"]) ?? 50,
    maxTotalTokens: numberOrNull(record["maxTotalTokens"]),
    maxCostUsd: numberOrNull(record["maxCostUsd"]),
    maxElapsedMs: numberOrNull(record["maxElapsedMs"]),
    maxConsecutiveInvalid: numberOrNull(record["maxConsecutiveInvalid"]) ?? 3,
    stallIterations: numberOrNull(record["stallIterations"]) ?? 2,
    requireApprovalBeforeEvaluation: record["requireApprovalBeforeEvaluation"] === true,
    analyzerModel: stringOrNull(record["analyzerModel"]),
  };
}

export function parseConfigSnapshot(value: Prisma.JsonValue | null): OptimizationConfigSnapshot | null {
  const record = asRecord(value);
  return record === null ? null : (record as unknown as OptimizationConfigSnapshot);
}

export function parseCandidateValidation(value: Prisma.JsonValue | null): CandidateValidation | null {
  const record = asRecord(value);
  if (record === null || typeof record["ok"] !== "boolean") {
    return null;
  }
  return {
    ok: record["ok"],
    issues: Array.isArray(record["issues"])
      ? (record["issues"] as unknown[])
          .map((entry) => asRecord(entry as Prisma.JsonValue))
          .filter((entry): entry is Record<string, unknown> => entry !== null)
          .map((entry) => ({
            code: stringOrNull(entry["code"]) ?? "UNKNOWN",
            message: stringOrNull(entry["message"]) ?? "",
          }))
      : [],
    nodeCount: numberOrNull(record["nodeCount"]) ?? 0,
    edgeCount: numberOrNull(record["edgeCount"]) ?? 0,
    entryNode: stringOrNull(record["entryNode"]),
  };
}

export function parseChangeSet(value: Prisma.JsonValue | null): MutationChange[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return (value as unknown[]).map((entry) => {
    const record = asRecord(entry as Prisma.JsonValue) ?? {};
    return {
      operation: stringOrNull(record["operation"]) ?? "unknown",
      target: stringOrNull(record["target"]) ?? "",
      before: record["before"] ?? null,
      after: record["after"] ?? null,
      reason: stringOrNull(record["reason"]) ?? "",
      risk: (stringOrNull(record["risk"]) ?? "LOW") as MutationRisk,
    };
  });
}

export function parseAcceptanceDecision(value: Prisma.JsonValue | null): AcceptanceDecision | null {
  const record = asRecord(value);
  if (record === null || typeof record["kind"] !== "string") {
    return null;
  }
  return record as unknown as AcceptanceDecision;
}

function parseTraceRefs(value: Prisma.JsonValue | null): TraceRef[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return (value as unknown[]).map((entry) => {
    const record = asRecord(entry as Prisma.JsonValue) ?? {};
    return {
      caseKey: stringOrNull(record["caseKey"]) ?? "",
      runId: stringOrNull(record["runId"]),
      stepIndexes: Array.isArray(record["stepIndexes"])
        ? (record["stepIndexes"] as unknown[]).filter((index): index is number => typeof index === "number")
        : [],
      note: stringOrNull(record["note"]) ?? "",
    };
  });
}

// --- Row mappers ---------------------------------------------------------------

type SessionRow = Prisma.OptimizationSessionGetPayload<Record<string, never>>;

function toSession(row: SessionRow): OptimizationSessionRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    agentId: row.agentId,
    harnessId: row.harnessId,
    name: row.name,
    description: row.description,
    status: row.status as OptimizationStatus,
    strategy: row.strategy as OptimizationStrategyKind,
    baselineVersionId: row.baselineVersionId,
    sourceBatchId: row.sourceBatchId,
    datasetId: row.datasetId,
    datasetVersionId: row.datasetVersionId,
    evaluatorConfig: parseEvaluatorAssignments(row.evaluatorConfig),
    scoringPolicy: row.scoringPolicy === "IGNORE_MISSING" ? "IGNORE_MISSING" : "REQUIRE_ALL",
    passThreshold: row.passThreshold,
    objective: parseObjective(row.objective),
    constraints: parseConstraints(row.constraints),
    limits: parseLimits(row.limits),
    configSnapshot: parseConfigSnapshot(row.configSnapshot),
    currentIteration: row.currentIteration,
    maxIterations: row.maxIterations,
    candidateCount: row.candidateCount,
    runCount: row.runCount,
    tokenUsage: row.tokenUsage,
    estimatedCostUsd: row.estimatedCostUsd,
    analyzerTokenUsage: row.analyzerTokenUsage,
    stopReason: row.stopReason,
    report: (asRecord(row.report) as unknown as OptimizationReport | null) ?? null,
    bestCandidateId: row.bestCandidateId,
    promotedCandidateId: row.promotedCandidateId,
    requireApproval: row.requireApproval,
    cancelRequestedAt: row.cancelRequestedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toFinding(row: Prisma.FailureFindingGetPayload<Record<string, never>>): FailureFindingRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    category: row.category as FailureCategory,
    summary: row.summary,
    frequency: row.frequency,
    confidence: row.confidence as FindingConfidence,
    impact: row.impact,
    investigation: row.investigation,
    isLlm: row.isLlm,
    caseKeys: row.caseKeys,
    runIds: row.runIds,
    evaluatorKeys: row.evaluatorKeys,
    traceRefs: parseTraceRefs(row.traceRefs),
    hypothesisIds: row.hypothesisIds,
    createdAt: row.createdAt,
  };
}

function toHypothesis(
  row: Prisma.ImprovementHypothesisGetPayload<Record<string, never>>,
): ImprovementHypothesisRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    findingId: row.findingId,
    category: row.category as FailureCategory,
    title: row.title,
    observation: row.observation,
    hypothesis: row.hypothesis,
    proposedChange: row.proposedChange,
    expectedOutcome: row.expectedOutcome,
    tradeoff: row.tradeoff,
    metricKeys: row.metricKeys,
    acceptanceCriteria: asRecord(row.acceptanceCriteria),
    confidence: row.confidence as FindingConfidence,
    requiresReview: row.requiresReview,
    origin: row.origin as OptimizationStrategyKind,
    status: row.status as ImprovementHypothesisRecord["status"],
    fingerprint: row.fingerprint,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toCandidate(
  row: Prisma.OptimizationCandidateGetPayload<Record<string, never>>,
): OptimizationCandidateRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    iteration: row.iteration,
    hypothesisId: row.hypothesisId,
    label: row.label,
    draftId: row.draftId,
    versionId: row.versionId,
    contentHash: row.contentHash,
    status: row.status as OptimizationCandidateStatus,
    validation: parseCandidateValidation(row.validation),
    changeSet: parseChangeSet(row.changeSet),
    pendingDefinition: row.pendingDefinition ?? null,
    baselineMetrics: parseBatchMetrics(row.baselineMetrics ?? null),
    metrics: parseBatchMetrics(row.metrics ?? null),
    evaluationBatchId: row.evaluationBatchId,
    decision: parseAcceptanceDecision(row.decision),
    decisionKind: (row.decisionKind as OptimizationDecisionKind | null) ?? null,
    fingerprint: row.fingerprint,
    analyzerTokenUsage: row.analyzerTokenUsage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toEvent(row: Prisma.OptimizationEventGetPayload<Record<string, never>>): OptimizationEventRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    kind: row.kind,
    message: row.message,
    ref: row.ref,
    payload: asRecord(row.payload),
    createdAt: row.createdAt,
  };
}

// --- Inputs --------------------------------------------------------------------

export interface CreateSessionInput {
  projectId: string;
  agentId: string;
  harnessId: string;
  name: string;
  description: string | null;
  strategy: OptimizationStrategyKind;
  baselineVersionId: string;
  sourceBatchId: string;
  datasetId: string;
  datasetVersionId: string;
  evaluatorConfig: EvaluatorAssignmentSnapshot[];
  scoringPolicy: ScoringPolicy;
  passThreshold: number | null;
  objective: OptimizationObjective;
  constraints: OptimizationConstraints;
  limits: OptimizationLimits;
  requireApproval: boolean;
  createdBy: string | null;
}

export interface UpdateSessionDraftInput {
  name?: string;
  description?: string | null;
  baselineVersionId?: string;
  sourceBatchId?: string;
  strategy?: OptimizationStrategyKind;
  objective?: OptimizationObjective;
  constraints?: OptimizationConstraints;
  limits?: OptimizationLimits;
  requireApproval?: boolean;
}

export interface SessionCounters {
  currentIteration?: number;
  candidateCount?: number;
  runCount?: number;
  tokenUsage?: number;
  estimatedCostUsd?: number;
  analyzerTokenUsage?: number;
}

export interface CreateCandidateInput {
  sessionId: string;
  iteration: number;
  hypothesisId: string | null;
  label: string;
  fingerprint: string;
  status: OptimizationCandidateStatus;
  validation: CandidateValidation | null;
  changeSet: MutationChange[] | null;
  /** Written when the loop parks the candidate for approval (resumability). */
  pendingDefinition?: unknown;
  /** A candidate attached from an already-published version (manual strategy). */
  versionId?: string | null;
  contentHash?: string | null;
  analyzerTokenUsage: number;
}

export interface SessionMeta {
  agent: { id: string; name: string } | null;
  harness: { id: string; name: string; slug: string; agentId: string | null } | null;
  dataset: { id: string; name: string; slug: string; version: number } | null;
  baseline: { id: string; version: number; contentHash: string } | null;
  sourceBatch: { id: string; label: string | null; status: string; caseCount: number } | null;
}

/**
 * The batch view the analysis engine reads: cases, their runs, and the step-level
 * record of what happened. Three queries for the whole batch — never one per case.
 */
export interface SourceBatchFacts {
  batch: {
    id: string;
    projectId: string;
    agentId: string;
    harnessId: string;
    harnessVersionId: string;
    datasetId: string;
    datasetVersionId: string;
    /** The dataset version *number* this batch pinned (0 when unresolvable). */
    datasetVersion: number;
    datasetSnapshot: DatasetCaseSnapshot[];
    evaluatorConfig: EvaluatorAssignmentSnapshot[];
    scoringPolicy: ScoringPolicy;
    passThreshold: number | null;
    status: string;
    caseCount: number;
    metrics: BatchMetrics | null;
  };
  cases: SourceCaseFacts[];
}

export const optimizationRepository = {
  // --- sessions -----------------------------------------------------------------

  async createSession(input: CreateSessionInput): Promise<OptimizationSessionRecord> {
    const row = await getPrisma().optimizationSession.create({
      data: {
        projectId: input.projectId,
        agentId: input.agentId,
        harnessId: input.harnessId,
        name: input.name,
        description: input.description,
        status: "DRAFT",
        strategy: input.strategy,
        baselineVersionId: input.baselineVersionId,
        sourceBatchId: input.sourceBatchId,
        datasetId: input.datasetId,
        datasetVersionId: input.datasetVersionId,
        evaluatorConfig: input.evaluatorConfig as unknown as Prisma.InputJsonValue,
        scoringPolicy: input.scoringPolicy,
        passThreshold: input.passThreshold,
        objective: input.objective as unknown as Prisma.InputJsonValue,
        constraints: input.constraints as unknown as Prisma.InputJsonValue,
        limits: input.limits as unknown as Prisma.InputJsonValue,
        maxIterations: input.limits.maxIterations,
        requireApproval: input.requireApproval,
        createdBy: input.createdBy,
      },
    });
    return toSession(row);
  },

  async updateSessionDraft(
    sessionId: string,
    input: UpdateSessionDraftInput,
  ): Promise<OptimizationSessionRecord> {
    const row = await getPrisma().optimizationSession.update({
      where: { id: sessionId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.baselineVersionId !== undefined ? { baselineVersionId: input.baselineVersionId } : {}),
        ...(input.sourceBatchId !== undefined ? { sourceBatchId: input.sourceBatchId } : {}),
        ...(input.strategy !== undefined ? { strategy: input.strategy } : {}),
        ...(input.objective !== undefined
          ? { objective: input.objective as unknown as Prisma.InputJsonValue }
          : {}),
        ...(input.constraints !== undefined
          ? { constraints: input.constraints as unknown as Prisma.InputJsonValue }
          : {}),
        ...(input.limits !== undefined
          ? {
              limits: input.limits as unknown as Prisma.InputJsonValue,
              maxIterations: input.limits.maxIterations,
            }
          : {}),
        ...(input.requireApproval !== undefined ? { requireApproval: input.requireApproval } : {}),
      },
    });
    return toSession(row);
  },

  async findById(sessionId: string): Promise<OptimizationSessionRecord | null> {
    const row = await getPrisma().optimizationSession.findUnique({ where: { id: sessionId } });
    return row === null ? null : toSession(row);
  },

  async findMeta(sessionId: string): Promise<SessionMeta> {
    const row = await getPrisma().optimizationSession.findUnique({
      where: { id: sessionId },
      include: {
        agent: { select: { id: true, name: true } },
        harness: { select: { id: true, name: true, slug: true, agentId: true } },
        dataset: { select: { id: true, name: true, slug: true } },
        datasetVersion: { select: { version: true } },
        baselineVersion: { select: { id: true, version: true, contentHash: true } },
        sourceBatch: { select: { id: true, label: true, status: true, caseCount: true } },
      },
    });
    if (row === null) {
      return { agent: null, harness: null, dataset: null, baseline: null, sourceBatch: null };
    }
    return {
      agent: row.agent,
      harness: row.harness,
      dataset:
        row.dataset === null
          ? null
          : {
              id: row.dataset.id,
              name: row.dataset.name,
              slug: row.dataset.slug,
              version: row.datasetVersion?.version ?? 0,
            },
      baseline: row.baselineVersion,
      sourceBatch: row.sourceBatch,
    };
  },

  async list(input: {
    projectIds: string[];
    agentId?: string;
    status?: OptimizationStatus[];
    q?: string;
    limit?: number;
    offset?: number;
  }): Promise<{      rows: Array<{
        session: OptimizationSessionRecord;
        agentName: string;
        datasetName: string;
        baselineVersion: number;
        acceptedCount: number;
        bestCandidateLabel: string | null;
        /** The evidence batch's size and status, for the list view. */
        sourceBatchCaseCount: number;
        sourceBatchStatus: string | null;
      }>;
    total: number;
    limit: number;
    offset: number;
  }> {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const offset = Math.max(input.offset ?? 0, 0);
    const where: Prisma.OptimizationSessionWhereInput = {
      projectId: { in: input.projectIds },
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      ...(input.status !== undefined && input.status.length > 0 ? { status: { in: input.status } } : {}),
      ...(input.q !== undefined && input.q !== ""
        ? { name: { contains: input.q, mode: "insensitive" } }
        : {}),
    };

    const prisma = getPrisma();
    const [total, rows] = await Promise.all([
      prisma.optimizationSession.count({ where }),
      prisma.optimizationSession.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
        include: {
          agent: { select: { name: true } },
          dataset: { select: { name: true } },
          baselineVersion: { select: { version: true } },
          sourceBatch: { select: { caseCount: true, status: true } },
          candidates: { select: { id: true, label: true, decisionKind: true, status: true } },
        },
      }),
    ]);

    return {
      total,
      limit,
      offset,
      rows: rows.map((row) => {
        const session = toSession(row as unknown as SessionRow);
        const accepted = row.candidates.filter((candidate) => candidate.decisionKind === "ACCEPT");
        const best = row.candidates.find((candidate) => candidate.id === session.bestCandidateId) ?? null;
        return {
          session,
          agentName: row.agent?.name ?? "Agent",
          datasetName: row.dataset?.name ?? "Dataset",
          baselineVersion: row.baselineVersion?.version ?? 0,
          acceptedCount: accepted.length,
          bestCandidateLabel: best?.label ?? null,
          sourceBatchCaseCount: row.sourceBatch?.caseCount ?? 0,
          sourceBatchStatus: row.sourceBatch?.status ?? null,
        };
      }),
    };
  },

  /** Workspace-wide counters for the overview. Derived from rows, never invented. */
  async aggregateStats(input: {
    projectIds: string[];
    agentId?: string;
  }): Promise<{
    byStatus: Record<string, number>;
    total: number;
    candidateEvaluations: number;
    sessionsWithAcceptance: number;
    settledSessions: number;
    runCount: number;
    tokenUsage: number;
    estimatedCostUsd: number;
  }> {
    const prisma = getPrisma();
    if (input.projectIds.length === 0) {
      return {
        byStatus: {},
        total: 0,
        candidateEvaluations: 0,
        sessionsWithAcceptance: 0,
        settledSessions: 0,
        runCount: 0,
        tokenUsage: 0,
        estimatedCostUsd: 0,
      };
    }
    const where: Prisma.OptimizationSessionWhereInput = {
      projectId: { in: input.projectIds },
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
    };

    const [statusGroups, usage, candidateEvaluations, acceptedGroups] = await Promise.all([
      prisma.optimizationSession.groupBy({ by: ["status"], where, _count: { _all: true } }),
      prisma.optimizationSession.aggregate({
        where,
        _sum: { runCount: true, tokenUsage: true, estimatedCostUsd: true },
        _count: { _all: true },
      }),
      prisma.optimizationCandidate.count({
        where: {
          status: "EVALUATED",
          session: { projectId: { in: input.projectIds } },
        },
      }),
      prisma.optimizationCandidate.groupBy({
        by: ["sessionId"],
        where: { decisionKind: "ACCEPT", session: where },
      }),
    ]);

    const byStatus: Record<string, number> = {};
    for (const group of statusGroups) {
      byStatus[group.status] = group._count._all;
    }
    const settled = Object.entries(byStatus)
      .filter(([status]) =>
        ["COMPLETED", "PARTIALLY_COMPLETED", "FAILED", "CANCELLED"].includes(status),
      )
      .reduce((sum, [, count]) => sum + count, 0);

    return {
      byStatus,
      total: usage._count._all,
      candidateEvaluations,
      sessionsWithAcceptance: acceptedGroups.length,
      settledSessions: settled,
      runCount: usage._sum.runCount ?? 0,
      tokenUsage: usage._sum.tokenUsage ?? 0,
      estimatedCostUsd: usage._sum.estimatedCostUsd ?? 0,
    };
  },

  /**
   * Everything the cross-session history aggregates, in one pass.
   *
   * Findings, hypotheses and candidates are read as *facts* (categories,
   * operations, scores), not as rendered rows, so the aggregation can be a pure
   * function. Sessions are bounded and ordered newest-first: the history is a
   * comparison over a working set, not an unbounded scan.
   */
  async loadHistoryFacts(input: {
    projectIds: string[];
    agentId?: string;
    since?: Date;
    limit?: number;
  }): Promise<HistorySessionRow[]> {
    if (input.projectIds.length === 0) {
      return [];
    }
    const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
    const rows = await getPrisma().optimizationSession.findMany({
      where: {
        projectId: { in: input.projectIds },
        ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
        ...(input.since !== undefined ? { createdAt: { gte: input.since } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        findings: { select: { category: true, confidence: true, isLlm: true } },
        hypotheses: { select: { id: true, category: true, origin: true, status: true } },
        candidates: {
          select: {
            id: true,
            label: true,
            iteration: true,
            hypothesisId: true,
            status: true,
            decisionKind: true,
            metrics: true,
            baselineMetrics: true,
            validation: true,
            changeSet: true,
          },
        },
      },
    });

    return rows.map((row) => ({
      session: {
        id: row.id,
        name: row.name,
        strategy: row.strategy as OptimizationStrategyKind,
        status: row.status as OptimizationStatus,
        stopReason: row.stopReason,
        objective: parseObjective(row.objective),
        createdAt: row.createdAt,
        completedAt: row.completedAt,
      },
      findings: row.findings.map((finding) => ({
        category: finding.category,
        confidence: finding.confidence,
        isLlm: finding.isLlm,
      })),
      hypotheses: row.hypotheses.map((hypothesis) => ({
        id: hypothesis.id,
        category: hypothesis.category,
        origin: hypothesis.origin,
        status: hypothesis.status,
      })),
      candidates: row.candidates.map((candidate) => ({
        id: candidate.id,
        label: candidate.label,
        iteration: candidate.iteration,
        hypothesisId: candidate.hypothesisId,
        status: candidate.status,
        decisionKind: candidate.decisionKind,
        metrics: parseBatchMetrics(candidate.metrics),
        baselineMetrics: parseBatchMetrics(candidate.baselineMetrics),
        validation: parseCandidateValidation(candidate.validation),
        changeSet: parseChangeSet(candidate.changeSet),
      })),
    }));
  },

  /** Atomically claims a QUEUED session. A redelivered job claims nothing. */
  async claimForRun(sessionId: string): Promise<boolean> {
    const claimed = await getPrisma().optimizationSession.updateMany({
      where: { id: sessionId, status: "QUEUED", cancelRequestedAt: null },
      data: { status: "RUNNING" },
    });
    return claimed.count > 0;
  },

  /**
   * Requeues a RUNNING session whose pass died. Only the *orchestrator's* caller
   * (an explicit resume action, or recovery after a worker restart) uses this,
   * and only after the claim has gone stale — otherwise two passes would run.
   */
  async reclaimStale(sessionId: string, staleMs: number): Promise<boolean> {
    const threshold = new Date(Date.now() - staleMs);
    const reclaimed = await getPrisma().optimizationSession.updateMany({
      where: {
        id: sessionId,
        status: "RUNNING",
        cancelRequestedAt: null,
        updatedAt: { lt: threshold },
      },
      data: { status: "QUEUED" },
    });
    return reclaimed.count > 0;
  },

  async updateStatus(
    sessionId: string,
    input: {
      status: OptimizationStatus;
      startedAt?: Date | null;
      completedAt?: Date | null;
      cancelRequestedAt?: Date | null;
      stopReason?: string | null;
    },
  ): Promise<void> {
    await getPrisma().optimizationSession.update({
      where: { id: sessionId },
      data: {
        status: input.status,
        ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
        ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
        ...(input.cancelRequestedAt !== undefined ? { cancelRequestedAt: input.cancelRequestedAt } : {}),
        ...(input.stopReason !== undefined ? { stopReason: input.stopReason } : {}),
      },
    });
  },

  /** Seals the session: snapshot + status in one statement. */
  async sealSession(input: {
    sessionId: string;
    snapshot: OptimizationConfigSnapshot;
    status: OptimizationStatus;
    startedAt: Date;
  }): Promise<void> {
    await getPrisma().optimizationSession.update({
      where: { id: input.sessionId },
      data: {
        configSnapshot: input.snapshot as unknown as Prisma.InputJsonValue,
        status: input.status,
        startedAt: input.startedAt,
        completedAt: null,
        stopReason: null,
      },
    });
  },

  async setCounters(sessionId: string, counters: SessionCounters): Promise<void> {
    await getPrisma().optimizationSession.update({
      where: { id: sessionId },
      data: {
        ...(counters.currentIteration !== undefined ? { currentIteration: counters.currentIteration } : {}),
        ...(counters.candidateCount !== undefined ? { candidateCount: counters.candidateCount } : {}),
        ...(counters.runCount !== undefined ? { runCount: counters.runCount } : {}),
        ...(counters.tokenUsage !== undefined ? { tokenUsage: counters.tokenUsage } : {}),
        ...(counters.estimatedCostUsd !== undefined
          ? { estimatedCostUsd: counters.estimatedCostUsd }
          : {}),
        ...(counters.analyzerTokenUsage !== undefined
          ? { analyzerTokenUsage: counters.analyzerTokenUsage }
          : {}),
      },
    });
  },

  /**
   * Adds spent analyzer tokens to the session's running total.
   *
   * Incremented rather than written, because this is the one usage figure that
   * cannot be recomputed from candidate rows: the analysis pass spends before a
   * candidate exists, and a proposal that never becomes one still cost money.
   */
  async addAnalyzerUsage(sessionId: string, tokens: number): Promise<void> {
    if (!Number.isFinite(tokens) || tokens <= 0) {
      return;
    }
    await getPrisma().optimizationSession.update({
      where: { id: sessionId },
      data: { analyzerTokenUsage: { increment: Math.round(tokens) } },
    });
  },

  async saveReport(sessionId: string, report: OptimizationReport): Promise<void> {
    await getPrisma().optimizationSession.update({
      where: { id: sessionId },
      data: { report: report as unknown as Prisma.InputJsonValue },
    });
  },

  async requestCancellation(sessionId: string): Promise<void> {
    await getPrisma().optimizationSession.updateMany({
      where: {
        id: sessionId,
        status: { in: ["DRAFT", "QUEUED", "RUNNING", "WAITING_FOR_REVIEW"] },
      },
      data: { cancelRequestedAt: new Date() },
    });
  },

  async setBestCandidate(sessionId: string, candidateId: string | null): Promise<void> {
    await getPrisma().optimizationSession.update({
      where: { id: sessionId },
      data: { bestCandidateId: candidateId },
    });
  },

  async setPromotion(
    sessionId: string,
    input: { candidateId: string; notes: string | null; userId: string },
  ): Promise<void> {
    await getPrisma().optimizationSession.update({
      where: { id: sessionId },
      data: {
        promotedCandidateId: input.candidateId,
      },
    });
    await getPrisma().optimizationEvent.create({
      data: {
        sessionId,
        kind: "candidate.promoted",
        message: input.notes ?? "The accepted candidate was promoted to the harness's current version.",
        ref: input.candidateId,
        payload: { userId: input.userId } as unknown as Prisma.InputJsonValue,
      },
    });
  },

  // --- findings ------------------------------------------------------------------

  /** Replaces a session's findings; analysis is idempotent per pass. */
  async replaceFindings(sessionId: string, drafts: readonly FindingDraft[]): Promise<FailureFindingRecord[]> {
    const now = new Date();
    const prisma = getPrisma();
    const created = await prisma.$transaction(async (tx) => {
      await tx.failureFinding.deleteMany({ where: { sessionId } });
      const rows: Array<Prisma.FailureFindingGetPayload<Record<string, never>>> = [];
      for (const draft of drafts) {
        rows.push(
          await tx.failureFinding.create({
            data: {
              sessionId,
              category: draft.category,
              summary: draft.summary,
              frequency: draft.frequency,
              confidence: draft.confidence,
              impact: draft.impact,
              investigation: draft.investigation,
              isLlm: draft.isLlm,
              caseKeys: draft.caseKeys,
              runIds: draft.runIds,
              evaluatorKeys: draft.evaluatorKeys,
              traceRefs: draft.traceRefs as unknown as Prisma.InputJsonValue,
              hypothesisIds: [],
              createdAt: now,
            },
          }),
        );
      }
      return rows;
    });
    return created.map(toFinding);
  },

  async listFindings(sessionId: string): Promise<FailureFindingRecord[]> {
    const rows = await getPrisma().failureFinding.findMany({
      where: { sessionId },
      orderBy: [{ createdAt: "asc" }],
    });
    return rows.map(toFinding);
  },

  async attachHypothesisToFinding(findingId: string, hypothesisId: string): Promise<void> {
    const row = await getPrisma().failureFinding.findUnique({ where: { id: findingId } });
    if (row === null || row.hypothesisIds.includes(hypothesisId)) {
      return;
    }
    await getPrisma().failureFinding.update({
      where: { id: findingId },
      data: { hypothesisIds: [...row.hypothesisIds, hypothesisId] },
    });
  },

  // --- hypotheses -----------------------------------------------------------------

  /**
   * Inserts proposals, skipping the ones already stored (unique fingerprint), and
   * returns both halves — so the caller can log "3 new, 2 already known" instead
   * of silently regenerating.
   */
  async createHypotheses(
    sessionId: string,
    proposals: ReadonlyArray<ProposedHypothesis & { fingerprint: string }>,
  ): Promise<{ created: ImprovementHypothesisRecord[]; skipped: string[] }> {
    const prisma = getPrisma();
    const created: ImprovementHypothesisRecord[] = [];
    const skipped: string[] = [];
    for (const proposal of proposals) {
      const existing = await prisma.improvementHypothesis.findUnique({
        where: { sessionId_fingerprint: { sessionId, fingerprint: proposal.fingerprint } },
      });
      if (existing !== null) {
        skipped.push(proposal.fingerprint);
        continue;
      }
      const row = await prisma.improvementHypothesis.create({
        data: {
          sessionId,
          findingId: proposal.findingIds[0] ?? null,
          category: proposal.category,
          title: proposal.title,
          observation: proposal.observation,
          hypothesis: proposal.hypothesis,
          proposedChange: proposal.proposedChange,
          expectedOutcome: proposal.expectedOutcome,
          tradeoff: proposal.tradeoff,
          metricKeys: proposal.metricKeys,
          acceptanceCriteria: (proposal.acceptanceCriteria ?? {}) as unknown as Prisma.InputJsonValue,
          confidence: proposal.confidence,
          requiresReview: proposal.requiresReview,
          origin: proposal.origin,
          status: "PROPOSED",
          fingerprint: proposal.fingerprint,
        },
      });
      created.push(toHypothesis(row));
    }
    return { created, skipped };
  },

  async listHypotheses(sessionId: string): Promise<ImprovementHypothesisRecord[]> {
    const rows = await getPrisma().improvementHypothesis.findMany({
      where: { sessionId },
      orderBy: [{ createdAt: "asc" }],
    });
    return rows.map(toHypothesis);
  },

  async findHypothesis(sessionId: string, hypothesisId: string): Promise<ImprovementHypothesisRecord | null> {
    const row = await getPrisma().improvementHypothesis.findFirst({
      where: { id: hypothesisId, sessionId },
    });
    return row === null ? null : toHypothesis(row);
  },

  async setHypothesisStatus(
    hypothesisId: string,
    status: ImprovementHypothesisRecord["status"],
  ): Promise<void> {
    await getPrisma().improvementHypothesis.update({ where: { id: hypothesisId }, data: { status } });
  },

  // --- candidates -----------------------------------------------------------------

  async createCandidate(input: CreateCandidateInput): Promise<OptimizationCandidateRecord> {
    const row = await getPrisma().optimizationCandidate.create({
      data: {
        sessionId: input.sessionId,
        iteration: input.iteration,
        hypothesisId: input.hypothesisId,
        label: input.label,
        status: input.status,
        fingerprint: input.fingerprint,
        validation: (input.validation ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue,
        changeSet: (input.changeSet ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue,
        pendingDefinition: (input.pendingDefinition ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        ...(input.versionId !== undefined && input.versionId !== null ? { versionId: input.versionId } : {}),
        ...(input.contentHash !== undefined && input.contentHash !== null
          ? { contentHash: input.contentHash }
          : {}),
        analyzerTokenUsage: input.analyzerTokenUsage,
      },
    });
    return toCandidate(row);
  },

  async findCandidate(sessionId: string, candidateId: string): Promise<OptimizationCandidateRecord | null> {
    const row = await getPrisma().optimizationCandidate.findFirst({
      where: { id: candidateId, sessionId },
    });
    return row === null ? null : toCandidate(row);
  },

  async findCandidateByFingerprint(
    sessionId: string,
    fingerprint: string,
  ): Promise<OptimizationCandidateRecord | null> {
    const row = await getPrisma().optimizationCandidate.findFirst({
      where: { sessionId, fingerprint },
    });
    return row === null ? null : toCandidate(row);
  },

  async listCandidates(sessionId: string): Promise<OptimizationCandidateRecord[]> {
    const rows = await getPrisma().optimizationCandidate.findMany({
      where: { sessionId },
      orderBy: [{ iteration: "asc" }, { createdAt: "asc" }],
    });
    return rows.map(toCandidate);
  },

  /**
   * The candidate a human has approved but the loop has not evaluated yet.
   *
   * This is what makes the approval gate resumable: the reviewer approves a row
   * that already carries its validated definition, and the next pass publishes and
   * evaluates *that* candidate rather than proposing a new one. Only a decision
   * with a non-system actor counts as approval — never the loop's own verdict. A
   * manually attached candidate arrives with its version already published, so the
   * query keys on "not evaluated yet" rather than on "no version yet".
   */
  async findApprovedCandidateAwaitingEvaluation(
    sessionId: string,
  ): Promise<OptimizationCandidateRecord | null> {
    const prisma = getPrisma();
    const approvals = await prisma.optimizationDecision.findMany({
      where: { sessionId, kind: "ACCEPT", actor: { not: "system" }, candidateId: { not: null } },
      orderBy: { createdAt: "asc" },
      select: { candidateId: true },
    });
    const candidateIds = approvals
      .map((decision) => decision.candidateId)
      .filter((id): id is string => id !== null);
    if (candidateIds.length === 0) {
      return null;
    }
    const row = await prisma.optimizationCandidate.findFirst({
      where: {
        sessionId,
        id: { in: candidateIds },
        evaluationBatchId: null,
        status: "PROPOSED",
        pendingDefinition: { not: Prisma.JsonNull },
      },
      orderBy: { createdAt: "asc" },
    });
    return row === null ? null : toCandidate(row);
  },

  async updateCandidate(
    candidateId: string,
    patch: {
      status?: OptimizationCandidateStatus;
      validation?: CandidateValidation | null;
      changeSet?: MutationChange[] | null;
      pendingDefinition?: unknown;
      clearPendingDefinition?: boolean;
      baselineMetrics?: BatchMetrics | null;
      metrics?: BatchMetrics | null;
      evaluationBatchId?: string | null;
      versionId?: string | null;
      draftId?: string | null;
      contentHash?: string | null;
      decision?: AcceptanceDecision | null;
      decisionKind?: OptimizationDecisionKind | null;
      analyzerTokenUsage?: number;
    },
  ): Promise<void> {
    await getPrisma().optimizationCandidate.update({
      where: { id: candidateId },
      data: {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.validation !== undefined
          ? { validation: (patch.validation ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue }
          : {}),
        ...(patch.changeSet !== undefined
          ? { changeSet: (patch.changeSet ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue }
          : {}),
        ...(patch.pendingDefinition !== undefined
          ? { pendingDefinition: (patch.pendingDefinition ?? Prisma.JsonNull) as Prisma.InputJsonValue }
          : {}),
        ...(patch.clearPendingDefinition === true ? { pendingDefinition: Prisma.JsonNull } : {}),
        ...(patch.baselineMetrics !== undefined
          ? {
              baselineMetrics: (patch.baselineMetrics ??
                Prisma.JsonNull) as unknown as Prisma.InputJsonValue,
            }
          : {}),
        ...(patch.metrics !== undefined
          ? { metrics: (patch.metrics ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue }
          : {}),
        ...(patch.evaluationBatchId !== undefined ? { evaluationBatchId: patch.evaluationBatchId } : {}),
        ...(patch.versionId !== undefined ? { versionId: patch.versionId } : {}),
        ...(patch.draftId !== undefined ? { draftId: patch.draftId } : {}),
        ...(patch.contentHash !== undefined ? { contentHash: patch.contentHash } : {}),
        ...(patch.decision !== undefined
          ? { decision: (patch.decision ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue }
          : {}),
        ...(patch.decisionKind !== undefined ? { decisionKind: patch.decisionKind } : {}),
        ...(patch.analyzerTokenUsage !== undefined
          ? { analyzerTokenUsage: patch.analyzerTokenUsage }
          : {}),
      },
    });
  },

  /** Records the typed operations a candidate was built from (audit trail). */
  async addMutations(
    candidateId: string,
    changes: readonly MutationChange[],
  ): Promise<HarnessMutationRecord[]> {
    const prisma = getPrisma();
    const rows: HarnessMutationRecord[] = [];
    for (const change of changes) {
      const row = await prisma.harnessMutation.create({
        data: {
          candidateId,
          operation: change.operation,
          target: change.target,
          before: (change.before ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          after: (change.after ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          reason: change.reason,
          risk: change.risk,
          applied: true,
        },
      });
      rows.push({
        id: row.id,
        candidateId: row.candidateId,
        operation: row.operation,
        target: row.target,
        before: row.before,
        after: row.after,
        reason: row.reason,
        risk: row.risk as MutationRisk,
        applied: row.applied,
        createdAt: row.createdAt,
      });
    }
    return rows;
  },

  async listMutations(candidateId: string): Promise<HarnessMutationRecord[]> {
    const rows = await getPrisma().harnessMutation.findMany({
      where: { candidateId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((row) => ({
      id: row.id,
      candidateId: row.candidateId,
      operation: row.operation,
      target: row.target,
      before: row.before,
      after: row.after,
      reason: row.reason,
      risk: row.risk as MutationRisk,
      applied: row.applied,
      createdAt: row.createdAt,
    }));
  },

  // --- decisions and events -------------------------------------------------------

  async recordDecision(input: {
    sessionId: string;
    candidateId: string | null;
    kind: OptimizationDecisionKind;
    rationale: Record<string, unknown> | AcceptanceDecision;
    actor: string;
  }): Promise<void> {
    await getPrisma().optimizationDecision.create({
      data: {
        sessionId: input.sessionId,
        candidateId: input.candidateId,
        kind: input.kind,
        rationale: input.rationale as unknown as Prisma.InputJsonValue,
        actor: input.actor,
      },
    });
  },

  async listDecisions(sessionId: string): Promise<
    Array<{
      id: string;
      candidateId: string | null;
      kind: OptimizationDecisionKind;
      rationale: Record<string, unknown> | null;
      actor: string;
      createdAt: Date;
    }>
  > {
    const rows = await getPrisma().optimizationDecision.findMany({
      where: { sessionId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((row) => ({
      id: row.id,
      candidateId: row.candidateId,
      kind: row.kind as OptimizationDecisionKind,
      rationale: asRecord(row.rationale),
      actor: row.actor,
      createdAt: row.createdAt,
    }));
  },

  /** Appends one timeline event. Events are never updated or deleted. */
  async appendEvent(input: {
    sessionId: string;
    kind: string;
    message: string;
    ref?: string | null;
    payload?: Record<string, unknown> | null;
  }): Promise<OptimizationEventRecord> {
    const row = await getPrisma().optimizationEvent.create({
      data: {
        sessionId: input.sessionId,
        kind: input.kind,
        message: input.message,
        ref: input.ref ?? null,
        payload: (input.payload ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      },
    });
    return toEvent(row);
  },

  async listEvents(
    sessionId: string,
    input: { limit?: number; offset?: number } = {},
  ): Promise<{ items: OptimizationEventRecord[]; total: number }> {
    const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
    const offset = Math.max(input.offset ?? 0, 0);
    const prisma = getPrisma();
    const [total, rows] = await Promise.all([
      prisma.optimizationEvent.count({ where: { sessionId } }),
      prisma.optimizationEvent.findMany({
        where: { sessionId },
        orderBy: { createdAt: "asc" },
        take: limit,
        skip: offset,
      }),
    ]);
    return { items: rows.map(toEvent), total };
  },

  // --- evidence reads -------------------------------------------------------------

  /**
   * Loads everything the analysis engine is allowed to see for one batch: the
   * batch's sealed configuration, its cases, the runs those cases produced and the
   * step-level record of what happened inside them.
   */
  async loadSourceBatch(batchId: string): Promise<SourceBatchFacts | null> {
    const prisma = getPrisma();
    const batch = await prisma.evaluationBatch.findUnique({
      where: { id: batchId },
      // The version *number* is what a report reader recognises; the pinned id
      // alone is opaque. One join, not a second round trip.
      include: { datasetVersion: { select: { version: true } } },
    });
    if (batch === null) {
      return null;
    }

    const caseRows = await prisma.evaluationCaseResult.findMany({
      where: { batchId },
      orderBy: { index: "asc" },
      include: { results: { orderBy: { evaluatorKey: "asc" } } },
    });

    const runIds = caseRows.map((row) => row.runId).filter((id): id is string => id !== null);
    const runs =
      runIds.length === 0
        ? []
        : await prisma.run.findMany({
            where: { id: { in: runIds } },
            select: {
              id: true,
              status: true,
              attempt: true,
              latencyMs: true,
              tokenUsage: true,
              error: true,
            },
          });
    const runById = new Map(runs.map((run) => [run.id, run]));

    const steps =
      runIds.length === 0
        ? []
        : await prisma.runStep.findMany({
            where: { runId: { in: runIds } },
            orderBy: [{ runId: "asc" }, { index: "asc" }],
            select: {
              runId: true,
              index: true,
              nodeId: true,
              nodeType: true,
              status: true,
              iteration: true,
              error: true,
              metadata: true,
            },
          });

    const stepsByRun = new Map<string, typeof steps>();
    for (const step of steps) {
      const bucket = stepsByRun.get(step.runId);
      if (bucket === undefined) {
        stepsByRun.set(step.runId, [step]);
      } else {
        bucket.push(step);
      }
    }

    const cases: SourceCaseFacts[] = caseRows.map((row) => {
      const run = row.runId === null ? null : (runById.get(row.runId) ?? null);
      const runSteps = row.runId === null ? [] : (stepsByRun.get(row.runId) ?? []);
      const tokenUsage = run?.tokenUsage as { totalTokens?: number } | null | undefined;
      const loopIterations =
        runSteps.reduce<number | null>((max, step) => {
          if (step.iteration === null) {
            return max;
          }
          return max === null ? step.iteration : Math.max(max, step.iteration);
        }, null);
      return {
        caseKey: row.caseKey,
        index: row.index,
        name: row.name,
        tags: row.tags,
        status: row.status as CaseStatus,
        runId: row.runId,
        runStatus: run?.status ?? null,
        aggregateScore: row.aggregateScore,
        aggregateStatus: (row.aggregateStatus as AggregateStatus | null) ?? null,
        passed: null,
        attempt: run?.attempt ?? 0,
        latencyMs: run?.latencyMs ?? null,
        totalTokens: typeof tokenUsage?.totalTokens === "number" ? tokenUsage.totalTokens : null,
        toolCalls: runSteps.filter((step) => step.nodeType === "tool").length,
        stepCount: runSteps.length,
        // A tool step records the tool it invoked in its metadata; when an
        // older step has none, the node id is the only honest fallback.
        toolsInvoked: runSteps
          .filter((step) => step.nodeType === "tool")
          .map((step) => {
            const metadata = asRecord(step.metadata as Prisma.JsonValue);
            const toolId = metadata === null ? null : stringOrNull(metadata["toolId"]);
            return toolId ?? step.nodeId;
          })
          .filter((entry) => entry !== ""),
        failedSteps: runSteps
          .filter((step) => step.status === "FAILED")
          .map((step) => {
            const error = asRecord(step.error as Prisma.JsonValue);
            return {
              index: step.index,
              nodeId: step.nodeId,
              nodeType: step.nodeType,
              code: stringOrNull(error?.["code"]),
              message: stringOrNull(error?.["message"]),
            };
          }),
        loopIterations,
        error: asRecord(row.error as Prisma.JsonValue) as SourceCaseFacts["error"],
        results: row.results.map((result) => ({
          evaluatorKey: result.evaluatorKey,
          evaluatorName: result.evaluatorName,
          kind: result.kind,
          status: result.status,
          passed: result.passed,
          normalizedScore: result.normalizedScore,
          explanation: result.explanation ?? "",
        })),
      };
    });

    return {
      batch: {
        id: batch.id,
        projectId: batch.projectId,
        agentId: batch.agentId,
        harnessId: batch.harnessId,
        harnessVersionId: batch.harnessVersionId,
        datasetId: batch.datasetId,
        datasetVersionId: batch.datasetVersionId,
        datasetVersion: batch.datasetVersion?.version ?? 0,
        datasetSnapshot: parseCaseSnapshot(batch.datasetSnapshot),
        evaluatorConfig: parseEvaluatorAssignments(batch.evaluatorConfig),
        scoringPolicy: batch.scoringPolicy === "IGNORE_MISSING" ? "IGNORE_MISSING" : "REQUIRE_ALL",
        passThreshold: batch.passThreshold,
        status: batch.status,
        caseCount: batch.caseCount,
        metrics: parseBatchMetrics(batch.metrics),
      },
      cases,
    };
  },

  /** The stored metrics of any batch (the baseline's numbers live here). */
  async loadBatchMetrics(batchId: string): Promise<BatchMetrics | null> {
    const row = await getPrisma().evaluationBatch.findUnique({
      where: { id: batchId },
      select: { metrics: true },
    });
    return row === null ? null : parseBatchMetrics(row.metrics);
  },

  /**
   * Run count the session actually created: case rows of its candidates' batches
   * that produced a run. Read from rows, so a crash cannot inflate or lose it.
   */
  async countSessionRuns(sessionId: string): Promise<number> {
    const candidates = await getPrisma().optimizationCandidate.findMany({
      where: { sessionId, evaluationBatchId: { not: null } },
      select: { evaluationBatchId: true },
    });
    const batchIds = candidates
      .map((candidate) => candidate.evaluationBatchId)
      .filter((id): id is string => id !== null);
    if (batchIds.length === 0) {
      return 0;
    }
    return getPrisma().evaluationCaseResult.count({
      where: { batchId: { in: batchIds }, runId: { not: null } },
    });
  },
};
