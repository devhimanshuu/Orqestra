import { Prisma } from "@/generated/prisma/client";
import { getPrisma } from "@/lib/db/prisma";
import { parseCaseSnapshot } from "@/modules/evaluation/dataset.repository";
import { parseEvaluatorAssignments, parseHarnessSnapshot } from "@/modules/evaluation/evaluation.repository";
import type { EvaluationResultView } from "@/modules/evaluation/batch.types";
import type { AggregateStatus, ScoringPolicy } from "@/modules/evaluation/evaluation.types";
import type { CaseStatus } from "@/modules/evaluation/batch.types";
import type { RunStatus } from "@/modules/runtime/run.types";
import type { DatasetCaseSnapshot } from "@/modules/evaluation/dataset.types";
import type { PricedUsage } from "@/modules/evaluation/pricing";
import type { EvaluatorAssignmentSnapshot } from "@/modules/evaluation/batch.types";
import type { CandidateCaseMetricRow, ExperimentMetrics } from "./experiment.metrics";
import type {
  ExperimentAssignmentRecord,
  ExperimentCandidateRecord,
  ExperimentConfigSnapshot,
  ExperimentConstraints,
  ExperimentExecution,
  ExperimentListItem,
  ExperimentObjective,
  ExperimentRecord,
  ExperimentSelectionKind,
  ExperimentStatus,
} from "./experiment.types";

/**
 * Experiment persistence.
 *
 * Two writes are load-bearing and both are transactional:
 *
 *  - **Sealing (`createLaunchPlan`)**. The candidates, their replicate batches,
 *    every assignment row and the immutable configuration snapshot are written
 *    in one statement, so a sealed experiment can never exist half-built. A
 *    candidate always has at least replicate 1 pointing at a real batch.
 *  - **Settling**. `Experiment.metrics` is only ever written from rows
 *    (`computeExperimentMetrics` over persisted cases), never from a counter the
 *    orchestrator kept in memory — a crashed worker therefore leaves an honest
 *    state.
 *
 * The assignment rows are read-only after launch: they describe what the
 * experiment *intends* to execute, while status, runs and verdicts live in the
 * Phase 3 rows the batches own. One writer per fact, so the two cannot disagree.
 */

// --- JSON helpers -------------------------------------------------------------

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

// --- Parsers for the sealed JSON columns --------------------------------------

export function parseObjective(value: Prisma.JsonValue): ExperimentObjective {
  const record = asRecord(value);
  if (record === null) {
    return { primary: { metric: "evaluation_score", direction: "maximize" }, secondary: [], notes: null };
  }
  const primary = asRecord(record["primary"] as Prisma.JsonValue);
  const secondary = Array.isArray(record["secondary"]) ? record["secondary"] : [];
  return {
    primary: {
      metric: (primary?.["metric"] as ExperimentObjective["primary"]["metric"]) ?? "evaluation_score",
      direction: primary?.["direction"] === "minimize" ? "minimize" : "maximize",
    },
    secondary: secondary
      .map((entry) => asRecord(entry as Prisma.JsonValue))
      .filter((entry): entry is Record<string, unknown> => entry !== null)
      .map((entry) => ({
        metric: entry["metric"] as ExperimentObjective["primary"]["metric"],
        direction: entry["direction"] === "minimize" ? ("minimize" as const) : ("maximize" as const),
      })),
    notes: stringOrNull(record["notes"]),
  };
}

export function parseConstraints(value: Prisma.JsonValue): ExperimentConstraints {
  const record = asRecord(value) ?? {};
  return {
    maxTotalCostUsd: numberOrNull(record["maxTotalCostUsd"]),
    maxMedianLatencyMs: numberOrNull(record["maxMedianLatencyMs"]),
    minPassRate: numberOrNull(record["minPassRate"]),
    minMeanScore: numberOrNull(record["minMeanScore"]),
    maxTotalTokens: numberOrNull(record["maxTotalTokens"]),
    maxToolCallsPerCase: numberOrNull(record["maxToolCallsPerCase"]),
  };
}

export function parseExecution(value: Prisma.JsonValue): ExperimentExecution {
  const record = asRecord(value) ?? {};
  const selection = asRecord(record["caseSelection"] as Prisma.JsonValue) ?? {};
  const retry = asRecord(record["retryPolicy"] as Prisma.JsonValue) ?? {};
  const budget = asRecord(record["budget"] as Prisma.JsonValue) ?? {};
  return {
    concurrency: numberOrNull(record["concurrency"]) ?? 1,
    ordering:
      record["ordering"] === "baseline_first" || record["ordering"] === "random"
        ? record["ordering"]
        : "interleaved",
    randomSeed: numberOrNull(record["randomSeed"]),
    replicates: numberOrNull(record["replicates"]) ?? 1,
    caseSelection: {
      tags: Array.isArray(selection["tags"])
        ? selection["tags"].filter((tag): tag is string => typeof tag === "string")
        : [],
      caseKeys: Array.isArray(selection["caseKeys"])
        ? selection["caseKeys"].filter((key): key is string => typeof key === "string")
        : [],
      limit: numberOrNull(selection["limit"]),
    },
    timeoutMs: numberOrNull(record["timeoutMs"]),
    limits: (asRecord(record["limits"] as Prisma.JsonValue) as ExperimentExecution["limits"]) ?? null,
    retryPolicy: { maxAttempts: numberOrNull(retry["maxAttempts"]) ?? 2 },
    budget: {
      maxRuns: numberOrNull(budget["maxRuns"]),
      maxTotalTokens: numberOrNull(budget["maxTotalTokens"]),
      maxCostUsd: numberOrNull(budget["maxCostUsd"]),
    },
  };
}

export function parseConfigSnapshot(value: Prisma.JsonValue | null): ExperimentConfigSnapshot | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  return record as unknown as ExperimentConfigSnapshot;
}

/** Lenient metrics reader: a partially written payload is reported as absent. */
export function parseExperimentMetrics(value: Prisma.JsonValue | null): ExperimentMetrics | null {
  const record = asRecord(value);
  if (record === null || !Array.isArray(record["candidates"])) {
    return null;
  }
  const numbers = {
    plannedExecutions: numberOrNull(record["plannedExecutions"]) ?? 0,
    executions: numberOrNull(record["executions"]) ?? 0,
    completed: numberOrNull(record["completed"]) ?? 0,
    failed: numberOrNull(record["failed"]) ?? 0,
    skipped: numberOrNull(record["skipped"]) ?? 0,
    cancelled: numberOrNull(record["cancelled"]) ?? 0,
    running: numberOrNull(record["running"]) ?? 0,
    pending: numberOrNull(record["pending"]) ?? 0,
    caseCount: numberOrNull(record["caseCount"]) ?? 0,
  };
  return {
    computedAt: stringOrNull(record["computedAt"]) ?? new Date(0).toISOString(),
    complete: record["complete"] === true,
    ...numbers,
    candidates: record["candidates"] as unknown as ExperimentMetrics["candidates"],
  };
}

// --- Row mappers --------------------------------------------------------------

type ExperimentRow = {
  id: string;
  projectId: string;
  agentId: string;
  name: string;
  description: string | null;
  hypothesis: string | null;
  status: string;
  datasetId: string;
  datasetVersionId: string;
  datasetSnapshot: Prisma.JsonValue;
  evaluatorConfig: Prisma.JsonValue;
  scoringPolicy: string;
  passThreshold: number | null;
  objective: Prisma.JsonValue;
  constraints: Prisma.JsonValue;
  execution: Prisma.JsonValue;
  configSnapshot: Prisma.JsonValue | null;
  caseCount: number;
  plannedRunCount: number;
  metrics: Prisma.JsonValue | null;
  selectedCandidateId: string | null;
  selectionKind: string | null;
  selectionNotes: string | null;
  selectedBy: string | null;
  selectedAt: Date | null;
  promotedCandidateId: string | null;
  promotionNotes: string | null;
  promotedBy: string | null;
  promotedAt: Date | null;
  cancelRequestedAt: Date | null;
  pausedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toExperiment(row: ExperimentRow): ExperimentRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    agentId: row.agentId,
    name: row.name,
    description: row.description,
    hypothesis: row.hypothesis,
    status: row.status as ExperimentStatus,
    datasetId: row.datasetId,
    datasetVersionId: row.datasetVersionId,
    datasetSnapshot: parseCaseSnapshot(row.datasetSnapshot),
    evaluatorConfig: parseEvaluatorAssignments(row.evaluatorConfig),
    scoringPolicy: row.scoringPolicy === "IGNORE_MISSING" ? "IGNORE_MISSING" : "REQUIRE_ALL",
    passThreshold: row.passThreshold,
    objective: parseObjective(row.objective),
    constraints: parseConstraints(row.constraints),
    execution: parseExecution(row.execution),
    configSnapshot: parseConfigSnapshot(row.configSnapshot),
    caseCount: row.caseCount,
    plannedRunCount: row.plannedRunCount,
    metrics: parseExperimentMetrics(row.metrics),
    selectedCandidateId: row.selectedCandidateId,
    selectionKind: (row.selectionKind as ExperimentSelectionKind | null) ?? null,
    selectionNotes: row.selectionNotes,
    selectedBy: row.selectedBy,
    selectedAt: row.selectedAt,
    promotedCandidateId: row.promotedCandidateId,
    promotionNotes: row.promotionNotes,
    promotedBy: row.promotedBy,
    promotedAt: row.promotedAt,
    cancelRequestedAt: row.cancelRequestedAt,
    pausedAt: row.pausedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toCandidate(row: {
  id: string;
  experimentId: string;
  label: string;
  role: string;
  hypothesis: string | null;
  orderIndex: number;
  harnessId: string;
  harnessVersionId: string;
  harnessVersion: number;
  contentHash: string;
  harnessSnapshot: Prisma.JsonValue;
  createdAt: Date;
  replicates?: Array<{ id: string; candidateId: string; replicate: number; evaluationBatchId: string }>;
}): ExperimentCandidateRecord {
  return {
    id: row.id,
    experimentId: row.experimentId,
    label: row.label,
    role: row.role === "BASELINE" ? "BASELINE" : "CANDIDATE",
    hypothesis: row.hypothesis,
    orderIndex: row.orderIndex,
    harnessId: row.harnessId,
    harnessVersionId: row.harnessVersionId,
    harnessVersion: row.harnessVersion,
    contentHash: row.contentHash,
    harnessSnapshot: parseHarnessSnapshot(row.harnessSnapshot),
    createdAt: row.createdAt,
    replicates: (row.replicates ?? [])
      .map((entry) => ({
        id: entry.id,
        candidateId: entry.candidateId,
        replicate: entry.replicate,
        evaluationBatchId: entry.evaluationBatchId,
      }))
      .sort((a, b) => a.replicate - b.replicate),
  };
}

function toAssignment(row: {
  id: string;
  experimentId: string;
  candidateId: string;
  datasetVersionId: string;
  caseKey: string;
  index: number;
  orderIndex: number;
  replicate: number;
  createdAt: Date;
}): ExperimentAssignmentRecord {
  return {
    id: row.id,
    experimentId: row.experimentId,
    candidateId: row.candidateId,
    datasetVersionId: row.datasetVersionId,
    caseKey: row.caseKey,
    index: row.index,
    orderIndex: row.orderIndex,
    replicate: row.replicate,
    createdAt: row.createdAt,
  };
}

// --- Inputs -------------------------------------------------------------------

export interface DraftConfigInput {
  datasetId: string;
  datasetVersionId: string;
  datasetSnapshot: DatasetCaseSnapshot[];
  evaluatorConfig: EvaluatorAssignmentSnapshot[];
  scoringPolicy: ScoringPolicy;
  passThreshold: number | null;
  objective: ExperimentObjective;
  constraints: ExperimentConstraints;
  execution: ExperimentExecution;
  caseCount: number;
  plannedRunCount: number;
}

export interface CreateDraftInput extends DraftConfigInput {
  projectId: string;
  agentId: string;
  name: string;
  description: string | null;
  hypothesis: string | null;
  /** The baseline plus every challenger, pinned at draft creation. */
  candidates: DraftCandidatePin[];
  createdBy: string | null;
}

export interface UpdateDraftInput extends Partial<DraftConfigInput> {
  name?: string;
  description?: string | null;
  hypothesis?: string | null;
  /** Present only when the baseline or the candidate set itself may have moved. */
  candidates?: DraftCandidatePin[];
}

export interface LaunchCandidateInput {
  label: string;
  role: "BASELINE" | "CANDIDATE";
  hypothesis: string | null;
  orderIndex: number;
  harnessId: string;
  harnessVersionId: string;
  harnessVersion: number;
  contentHash: string;
  harnessSnapshot: ExperimentCandidateRecord["harnessSnapshot"];
  replicates: Array<{ replicate: number; evaluationBatchId: string }>;
  assignments: Array<{ caseKey: string; index: number; orderIndex: number; replicate: number }>;
}

/**
 * A draft's immutable harness pins, written when the draft is created or its
 * baseline/candidates are edited. Replicates and assignments belong to the
 * sealed plan, so a draft row carries none of them.
 */
export type DraftCandidatePin = Omit<LaunchCandidateInput, "replicates" | "assignments">;

export interface CreateLaunchPlanInput {
  experimentId: string;
  configSnapshot: ExperimentConfigSnapshot;
  plannedRunCount: number;
  caseCount: number;
  startedAt: Date;
  candidates: LaunchCandidateInput[];
}

export interface ListExperimentsInput {
  projectIds: string[];
  agentId?: string;
  datasetId?: string;
  status?: ExperimentStatus[];
  /** Case-insensitive substring over the experiment name. */
  q?: string;
  sort: "createdAt" | "name" | "status" | "progress";
  order: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface ExperimentListPage {
  items: ExperimentListItem[];
  total: number;
  limit: number;
  offset: number;
  /**
   * Per-experiment inputs for the ranking rules (status, objective, constraints
   * and the *stored* metrics). The service turns these into a leader with the same
   * ranking function the comparison view uses, so a list and a detail page can
   * never disagree about who is ahead.
   */
  rankingInputs: Map<
    string,
    {
      status: ExperimentStatus;
      objective: ExperimentObjective;
      constraints: ExperimentConstraints;
      metrics: ExperimentMetrics | null;
    }
  >;
}

/** A case execution, tagged with the candidate/replicate it belongs to. */
export interface ExperimentCaseMetricRow extends CandidateCaseMetricRow {
  candidateId: string;
}

/** Row shape shared by draft-time pins and the sealed plan's candidates. */
function candidateRow(candidate: DraftCandidatePin) {
  return {
    label: candidate.label,
    role: candidate.role,
    hypothesis: candidate.hypothesis,
    orderIndex: candidate.orderIndex,
    harnessId: candidate.harnessId,
    harnessVersionId: candidate.harnessVersionId,
    harnessVersion: candidate.harnessVersion,
    contentHash: candidate.contentHash,
    harnessSnapshot: candidate.harnessSnapshot as unknown as Prisma.InputJsonValue,
  };
}

export const experimentRepository = {
  // --- drafts -----------------------------------------------------------------

  async createDraft(input: CreateDraftInput): Promise<ExperimentRecord> {
    const row = await getPrisma().experiment.create({
      data: {
        projectId: input.projectId,
        agentId: input.agentId,
        name: input.name,
        description: input.description,
        hypothesis: input.hypothesis,
        status: "DRAFT",
        datasetId: input.datasetId,
        datasetVersionId: input.datasetVersionId,
        datasetSnapshot: input.datasetSnapshot as unknown as Prisma.InputJsonValue,
        evaluatorConfig: input.evaluatorConfig as unknown as Prisma.InputJsonValue,
        scoringPolicy: input.scoringPolicy,
        passThreshold: input.passThreshold,
        objective: input.objective as unknown as Prisma.InputJsonValue,
        constraints: input.constraints as unknown as Prisma.InputJsonValue,
        execution: input.execution as unknown as Prisma.InputJsonValue,
        caseCount: input.caseCount,
        plannedRunCount: input.plannedRunCount,
        createdBy: input.createdBy,
        // The pins are rows from birth: pre-flight, edit and seal all re-read
        // them, so a draft must round-trip without its original request body.
        candidates: {
          create: input.candidates.map(candidateRow),
        },
      },
    });
    return toExperiment(row);
  },

  async updateDraft(experimentId: string, input: UpdateDraftInput): Promise<ExperimentRecord> {
    const data = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.hypothesis !== undefined ? { hypothesis: input.hypothesis } : {}),
      ...(input.datasetId !== undefined ? { datasetId: input.datasetId } : {}),
      ...(input.datasetVersionId !== undefined ? { datasetVersionId: input.datasetVersionId } : {}),
      ...(input.datasetSnapshot !== undefined
        ? { datasetSnapshot: input.datasetSnapshot as unknown as Prisma.InputJsonValue }
        : {}),
      ...(input.evaluatorConfig !== undefined
        ? { evaluatorConfig: input.evaluatorConfig as unknown as Prisma.InputJsonValue }
        : {}),
      ...(input.scoringPolicy !== undefined ? { scoringPolicy: input.scoringPolicy } : {}),
      ...(input.passThreshold !== undefined ? { passThreshold: input.passThreshold } : {}),
      ...(input.objective !== undefined
        ? { objective: input.objective as unknown as Prisma.InputJsonValue }
        : {}),
      ...(input.constraints !== undefined
        ? { constraints: input.constraints as unknown as Prisma.InputJsonValue }
        : {}),
      ...(input.execution !== undefined
        ? { execution: input.execution as unknown as Prisma.InputJsonValue }
        : {}),
      ...(input.caseCount !== undefined ? { caseCount: input.caseCount } : {}),
      ...(input.plannedRunCount !== undefined ? { plannedRunCount: input.plannedRunCount } : {}),
    };
    if (input.candidates === undefined) {
      const row = await getPrisma().experiment.update({ where: { id: experimentId }, data });
      return toExperiment(row);
    }
    // Pins are replaced wholesale when the baseline or candidates change: a
    // draft has no runs yet, so stale rows can be dropped rather than
    // reconciled against the (experimentId, label) unique constraint.
    const [, row] = await getPrisma().$transaction([
      getPrisma().experimentCandidate.deleteMany({ where: { experimentId } }),
      getPrisma().experiment.update({ where: { id: experimentId }, data }),
    ]);
    return toExperiment(row);
  },

  // --- reads ------------------------------------------------------------------

  async findById(experimentId: string): Promise<ExperimentRecord | null> {
    const row = await getPrisma().experiment.findUnique({ where: { id: experimentId } });
    return row ? toExperiment(row) : null;
  },

  async findMeta(experimentId: string): Promise<{
    agent: { id: string; name: string } | null;
    dataset: { id: string; name: string; slug: string; version: number } | null;
  }> {
    const row = await getPrisma().experiment.findUnique({
      where: { id: experimentId },
      include: {
        agent: { select: { id: true, name: true } },
        dataset: { select: { id: true, name: true, slug: true } },
        datasetVersion: { select: { version: true } },
      },
    });
    if (row === null) {
      return { agent: null, dataset: null };
    }
    return {
      agent: row.agent,
      dataset:
        row.dataset === null
          ? null
          : {
              id: row.dataset.id,
              name: row.dataset.name,
              slug: row.dataset.slug,
              version: row.datasetVersion?.version ?? 0,
            },
    };
  },

  /**
   * The experiments table. Candidate counts and versions come from the candidate
   * rows; progress and the leading candidate come from the stored metrics, so a
   * list page never recomputes (or invents) anything.
   */
  async list(input: ListExperimentsInput): Promise<ExperimentListPage> {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const offset = Math.max(input.offset ?? 0, 0);
    const where: Prisma.ExperimentWhereInput = {
      projectId: { in: input.projectIds },
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      ...(input.datasetId !== undefined ? { datasetId: input.datasetId } : {}),
      ...(input.status !== undefined && input.status.length > 0 ? { status: { in: input.status } } : {}),
      ...(input.q !== undefined && input.q !== ""
        ? { name: { contains: input.q, mode: "insensitive" } }
        : {}),
    };

    const orderBy: Prisma.ExperimentOrderByWithRelationInput =
      input.sort === "name"
        ? { name: input.order }
        : input.sort === "status"
          ? { status: input.order }
          : input.sort === "progress"
            ? { plannedRunCount: input.order }
            : { createdAt: input.order };

    const prisma = getPrisma();
    const [total, rows] = await Promise.all([
      prisma.experiment.count({ where }),
      prisma.experiment.findMany({
        where,
        orderBy,
        take: limit,
        skip: offset,
        include: {
          agent: { select: { id: true, name: true } },
          dataset: { select: { name: true } },
          datasetVersion: { select: { version: true } },
          candidates: {
            select: { id: true, label: true, role: true, harnessVersion: true, orderIndex: true },
            orderBy: { orderIndex: "asc" },
          },
        },
      }),
    ]);

    const rankingInputs = new Map<
      string,
      {
        status: ExperimentStatus;
        objective: ExperimentObjective;
        constraints: ExperimentConstraints;
        metrics: ExperimentMetrics | null;
      }
    >();

    const items: ExperimentListItem[] = rows.map((row) => {
      const experiment = toExperiment(row as unknown as ExperimentRow);
      rankingInputs.set(experiment.id, {
        status: experiment.status,
        objective: experiment.objective,
        constraints: experiment.constraints,
        metrics: experiment.metrics,
      });
      const metrics = experiment.metrics;
      const baseline = row.candidates.find((candidate) => candidate.role === "BASELINE") ?? null;
      return {
        id: experiment.id,
        name: experiment.name,
        status: experiment.status,
        agentId: experiment.agentId,
        agentName: row.agent?.name ?? "Agent",
        candidateCount: row.candidates.length,
        caseCount: experiment.caseCount,
        plannedRunCount: experiment.plannedRunCount,
        datasetId: experiment.datasetId,
        datasetName: row.dataset?.name ?? "Dataset",
        datasetVersion: row.datasetVersion?.version ?? 0,
        baselineHarnessVersion: baseline?.harnessVersion ?? null,
        primaryMetric: experiment.objective.primary.metric,
        primaryDirection: experiment.objective.primary.direction,
        // Filled in by the service, which owns the ranking rules.
        leadingCandidateLabel: null,
        leaderNote: null,
        completedExecutions: metrics?.completed ?? 0,
        failedExecutions: metrics?.failed ?? 0,
        createdAt: experiment.createdAt,
        startedAt: experiment.startedAt,
        completedAt: experiment.completedAt,
      };
    });

    return { items, total, limit, offset, rankingInputs };
  },

  // --- launch -----------------------------------------------------------------

  /**
   * Seals an experiment: writes the immutable snapshot, every candidate with its
   * replicate batches, and one assignment per (candidate, replicate, case), then
   * flips the status to QUEUED. Draft-time pin rows are cleared first so what
   * launches is exactly what was drafted — all in one transaction.
   */
  async createLaunchPlan(input: CreateLaunchPlanInput): Promise<void> {
    const update = getPrisma().experiment.update({
      where: { id: input.experimentId },
      data: {
        status: "QUEUED",
        startedAt: input.startedAt,
        completedAt: null,
        configSnapshot: input.configSnapshot as unknown as Prisma.InputJsonValue,
        plannedRunCount: input.plannedRunCount,
        caseCount: input.caseCount,
        candidates: {
          create: input.candidates.map((candidate) => ({
            label: candidate.label,
            role: candidate.role,
            hypothesis: candidate.hypothesis,
            orderIndex: candidate.orderIndex,
            harnessId: candidate.harnessId,
            harnessVersionId: candidate.harnessVersionId,
            harnessVersion: candidate.harnessVersion,
            contentHash: candidate.contentHash,
            harnessSnapshot: candidate.harnessSnapshot as unknown as Prisma.InputJsonValue,
            replicates: {
              create: candidate.replicates.map((replicate) => ({
                replicate: replicate.replicate,
                evaluationBatchId: replicate.evaluationBatchId,
              })),
            },
            runs: {
              create: candidate.assignments.map((assignment) => ({
                experimentId: input.experimentId,
                datasetVersionId: input.configSnapshot.dataset.versionId,
                caseKey: assignment.caseKey,
                index: assignment.index,
                orderIndex: assignment.orderIndex,
                replicate: assignment.replicate,
              })),
            },
          })),
        },
      },
    });
    await getPrisma().$transaction([
      getPrisma().experimentCandidate.deleteMany({ where: { experimentId: input.experimentId } }),
      update,
    ]);
  },

  // --- lifecycle --------------------------------------------------------------

  async updateStatus(
    experimentId: string,
    input: {
      status: ExperimentStatus;
      startedAt?: Date | null;
      completedAt?: Date | null;
      pausedAt?: Date | null;
      cancelRequestedAt?: Date | null;
    },
  ): Promise<void> {
    await getPrisma().experiment.update({
      where: { id: experimentId },
      data: {
        status: input.status,
        ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
        ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
        ...(input.pausedAt !== undefined ? { pausedAt: input.pausedAt } : {}),
        ...(input.cancelRequestedAt !== undefined ? { cancelRequestedAt: input.cancelRequestedAt } : {}),
      },
    });
  },

  /**
   * Atomically claims a QUEUED experiment for this worker pass. Returns false
   * when another pass already holds it — which is why a redelivered job is
   * harmless.
   *
   * PAUSED is deliberately *not* claimable: resuming moves the experiment back
   * to QUEUED first, so a fresh pass may only ever start from QUEUED. Without
   * that rule, pausing would race with the orchestrator claiming the experiment.
   */
  async claimForRun(experimentId: string): Promise<boolean> {
    const claimed = await getPrisma().experiment.updateMany({
      where: { id: experimentId, status: "QUEUED", cancelRequestedAt: null },
      data: { status: "RUNNING" },
    });
    return claimed.count > 0;
  },

  async saveMetrics(experimentId: string, metrics: ExperimentMetrics): Promise<void> {
    await getPrisma().experiment.update({
      where: { id: experimentId },
      data: { metrics: metrics as unknown as Prisma.InputJsonValue },
    });
  },

  async requestCancellation(experimentId: string): Promise<void> {
    await getPrisma().experiment.updateMany({
      where: { id: experimentId, status: { in: ["DRAFT", "QUEUED", "RUNNING", "PAUSED"] } },
      data: { cancelRequestedAt: new Date() },
    });
  },

  async requestPause(experimentId: string): Promise<boolean> {
    const paused = await getPrisma().experiment.updateMany({
      where: { id: experimentId, status: { in: ["QUEUED", "RUNNING"] } },
      data: { status: "PAUSED", pausedAt: new Date() },
    });
    return paused.count > 0;
  },

  async clearPause(experimentId: string): Promise<boolean> {
    const resumed = await getPrisma().experiment.updateMany({
      where: { id: experimentId, status: "PAUSED", cancelRequestedAt: null },
      data: { status: "QUEUED", pausedAt: null },
    });
    return resumed.count > 0;
  },

  // --- candidates and assignments ---------------------------------------------

  async listCandidates(experimentId: string): Promise<ExperimentCandidateRecord[]> {
    const rows = await getPrisma().experimentCandidate.findMany({
      where: { experimentId },
      orderBy: { orderIndex: "asc" },
      include: { replicates: true },
    });
    return rows.map(toCandidate);
  },

  async findCandidate(
    experimentId: string,
    candidateId: string,
  ): Promise<ExperimentCandidateRecord | null> {
    const row = await getPrisma().experimentCandidate.findFirst({
      where: { id: candidateId, experimentId },
      include: { replicates: true },
    });
    return row ? toCandidate(row) : null;
  },

  async listAssignments(experimentId: string): Promise<ExperimentAssignmentRecord[]> {
    const rows = await getPrisma().experimentRun.findMany({
      where: { experimentId },
      orderBy: { orderIndex: "asc" },
    });
    return rows.map(toAssignment);
  },

  async countAssignments(experimentId: string): Promise<number> {
    return getPrisma().experimentRun.count({ where: { experimentId } });
  },

  /**
   * Case rows for a set of batches, reduced to what cancellation needs: which
   * case, in which batch, in which state, and the row id that a terminal write
   * targets.
   */
  async listCaseStatuses(batchIds: readonly string[]): Promise<
    Array<{
      caseResultId: string;
      evaluationBatchId: string;
      caseKey: string;
      status: CaseStatus;
      runId: string | null;
    }>
  > {
    if (batchIds.length === 0) {
      return [];
    }
    const rows = await getPrisma().evaluationCaseResult.findMany({
      where: { batchId: { in: [...batchIds] } },
      select: { id: true, batchId: true, caseKey: true, status: true, runId: true },
    });
    return rows.map((row) => ({
      caseResultId: row.id,
      evaluationBatchId: row.batchId,
      caseKey: row.caseKey,
      status: row.status as CaseStatus,
      runId: row.runId,
    }));
  },

  /**
   * Case rows that are still RUNNING in the given batches, reduced to what
   * crash recovery needs: which case, how many attempts it has already had, and
   * when it was claimed. One query for the whole experiment.
   */
  async listRunningCases(batchIds: readonly string[]): Promise<
    Array<{
      id: string;
      evaluationBatchId: string;
      caseKey: string;
      attempts: number;
      startedAt: Date | null;
    }>
  > {
    if (batchIds.length === 0) {
      return [];
    }
    const rows = await getPrisma().evaluationCaseResult.findMany({
      where: { batchId: { in: [...batchIds] }, status: "RUNNING" },
      select: { id: true, batchId: true, caseKey: true, attempts: true, startedAt: true },
    });
    return rows.map((row) => ({
      id: row.id,
      evaluationBatchId: row.batchId,
      caseKey: row.caseKey,
      attempts: row.attempts,
      startedAt: row.startedAt,
    }));
  },

  /**
   * Every case execution of the given batches, with the run observables the
   * metrics and the per-case views need — three queries, never one per case.
   */
  async caseMetricRows(input: {
    batches: ReadonlyArray<{ evaluationBatchId: string; candidateId: string; replicate: number }>;
    passThreshold: number | null;
  }): Promise<ExperimentCaseMetricRow[]> {
    if (input.batches.length === 0) {
      return [];
    }
    const batchIds = input.batches.map((entry) => entry.evaluationBatchId);
    const byBatch = new Map(input.batches.map((entry) => [entry.evaluationBatchId, entry]));

    const prisma = getPrisma();
    const cases = await prisma.evaluationCaseResult.findMany({
      where: { batchId: { in: batchIds } },
      orderBy: { index: "asc" },
      include: { results: { orderBy: { evaluatorKey: "asc" } } },
    });

    const runIds = cases.map((row) => row.runId).filter((id): id is string => id !== null);
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
              usage: true,
            },
          });
    const runById = new Map(runs.map((run) => [run.id, run]));

    const stepsByRun =
      runIds.length === 0
        ? []
        : await prisma.runStep.groupBy({
            by: ["runId"],
            where: { runId: { in: runIds } },
            _count: { _all: true },
          });
    const steps = new Map(stepsByRun.map((row) => [row.runId, row._count._all]));

    const toolCallsByRun =
      runIds.length === 0
        ? []
        : await prisma.runStep.groupBy({
            by: ["runId"],
            where: { runId: { in: runIds }, nodeType: "tool" },
            _count: { _all: true },
          });
    const toolCalls = new Map(toolCallsByRun.map((row) => [row.runId, row._count._all]));

    return cases.map((row) => {
      const batch = byBatch.get(row.batchId);
      const run = row.runId === null ? null : (runById.get(row.runId) ?? null);
      const tokenUsage = run?.tokenUsage as { totalTokens?: number } | null | undefined;
      const usage: PricedUsage[] =
        run?.usage.map((entry) => ({
          provider: entry.provider,
          model: entry.model,
          promptTokens: entry.promptTokens,
          completionTokens: entry.completionTokens,
          recordedCostUsd: entry.costUsd,
        })) ?? [];
      return {
        candidateId: batch?.candidateId ?? "",
        replicate: batch?.replicate ?? 1,
        evaluationBatchId: row.batchId,
        caseResultId: row.id,
        caseKey: row.caseKey,
        index: row.index,
        status: row.status as CaseStatus,
        runId: row.runId,
        runStatus: (run?.status as RunStatus | undefined) ?? null,
        aggregateScore: row.aggregateScore,
        aggregateStatus: (row.aggregateStatus as AggregateStatus | null) ?? null,
        passed: derivedPassed(row.aggregateScore, row.aggregateStatus, input.passThreshold),
        latencyMs: run?.latencyMs ?? null,
        totalTokens: typeof tokenUsage?.totalTokens === "number" ? tokenUsage.totalTokens : null,
        attempt: run?.attempt ?? 0,
        toolCalls: row.runId === null ? 0 : (toolCalls.get(row.runId) ?? 0),
        stepCount: row.runId === null ? 0 : (steps.get(row.runId) ?? 0),
        usage,
        error: asRecord(row.error),
        results: row.results.map((result) => ({
          id: result.id,
          batchId: result.batchId,
          caseResultId: result.caseResultId,
          runId: result.runId,
          evaluatorId: result.evaluatorId,
          evaluatorVersion: result.evaluatorVersion,
          evaluatorKey: result.evaluatorKey,
          evaluatorName: result.evaluatorName,
          kind: result.kind as EvaluationResultView["kind"],
          status: result.status as EvaluationResultView["status"],
          score: result.score,
          maxScore: result.maxScore,
          normalizedScore: result.normalizedScore,
          passed: result.passed,
          explanation: result.explanation ?? "",
          evidence: asRecord(result.evidence),
          durationMs: result.durationMs ?? 0,
          metadata: asRecord(result.metadata),
          createdAt: result.createdAt,
        })),
      };
    });
  },

  /**
   * Read-only projection used for costing: terminal batches that ran any of the
   * given harness versions against the same dataset version. Their measured cost
   * and case counts are the only honest basis for an estimate before the
   * experiment executes.
   */
  async comparableBatchCostHistory(input: {
    harnessVersionIds: readonly string[];
    datasetVersionId: string;
  }): Promise<
    Array<{
      id: string;
      label: string | null;
      caseCount: number;
      status: string;
      costUsd: number | null;
      unpriced: string[];
      sources: string[];
      latencyMedianMs: number | null;
    }>
  > {
    if (input.harnessVersionIds.length === 0) {
      return [];
    }
    const rows = await getPrisma().evaluationBatch.findMany({
      where: {
        datasetVersionId: input.datasetVersionId,
        harnessVersionId: { in: [...input.harnessVersionIds] },
        status: { in: ["COMPLETED", "PARTIALLY_COMPLETED"] },
      },
      select: { id: true, label: true, caseCount: true, status: true, metrics: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    return rows
      .map((row) => {
        const metrics = asRecord(row.metrics);
        if (metrics === null) {
          return null;
        }
        const cost = asRecord(metrics["cost"] as Prisma.JsonValue);
        const latency = asRecord(metrics["latency"] as Prisma.JsonValue);
        return {
          id: row.id,
          label: row.label,
          caseCount: row.caseCount,
          status: row.status,
          costUsd: cost === null ? null : numberOrNull(cost["costUsd"]),
          unpriced:
            cost !== null && Array.isArray(cost["unpriced"])
              ? (cost["unpriced"] as unknown[]).filter((entry): entry is string => typeof entry === "string")
              : [],
          sources:
            cost !== null && Array.isArray(cost["sources"])
              ? (cost["sources"] as unknown[]).filter((entry): entry is string => typeof entry === "string")
              : [],
          latencyMedianMs: latency === null ? null : numberOrNull(latency["medianMs"]),
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  },

  /** An experiment already running for the same agent over the same dataset version. */
  async findInFlight(agentId: string, datasetVersionId: string): Promise<{ id: string } | null> {
    return getPrisma().experiment.findFirst({
      where: {
        agentId,
        datasetVersionId,
        status: { in: ["QUEUED", "RUNNING", "PAUSED"] },
      },
      select: { id: true },
    });
  },

  // --- selection and promotion -------------------------------------------------

  async setSelection(
    experimentId: string,
    input: {
      candidateId: string;
      kind: ExperimentSelectionKind;
      notes: string | null;
      userId: string;
    },
  ): Promise<void> {
    await getPrisma().experiment.update({
      where: { id: experimentId },
      data: {
        selectedCandidateId: input.candidateId,
        selectionKind: input.kind,
        selectionNotes: input.notes,
        selectedBy: input.userId,
        selectedAt: new Date(),
      },
    });
  },

  async setPromotion(
    experimentId: string,
    input: { candidateId: string; notes: string | null; userId: string },
  ): Promise<void> {
    await getPrisma().experiment.update({
      where: { id: experimentId },
      data: {
        promotedCandidateId: input.candidateId,
        promotionNotes: input.notes,
        promotedBy: input.userId,
        promotedAt: new Date(),
      },
    });
  },
};

/**
 * A case's pass verdict is derived, never stored: COMPLETE aggregate + a
 * configured threshold. Shared with the evaluation engine's rule so both views
 * agree on what "passed" means.
 */
export function derivedPassed(
  score: number | null,
  aggregateStatus: string | null,
  passThreshold: number | null,
): boolean | null {
  if (score === null || aggregateStatus !== "COMPLETE" || passThreshold === null) {
    return null;
  }
  return score >= passThreshold;
}

export type { Prisma };
