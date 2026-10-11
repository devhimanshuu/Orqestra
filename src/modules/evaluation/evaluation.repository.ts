import { Prisma } from "@/generated/prisma/client";
import { getPrisma } from "@/lib/db/prisma";
import type { DatasetCaseSnapshot } from "./dataset.types";
import type { BatchMetrics, BatchCaseMetricRow, EvaluatorMetric } from "./metrics";
import type { PricedUsage } from "./pricing";
import type {
  AggregateStatus,
  EvaluationResultRecord,
  EvaluatorKind,
  ScoringPolicy,
} from "./evaluation.types";
import type {
  BatchConfig,
  BatchListItem,
  BatchStatus,
  CaseStatus,
  EvaluationBatchRecord,
  EvaluationCaseRecord,
  EvaluationResultView,
  EvaluatorAssignmentSnapshot,
  HarnessSnapshot,
} from "./batch.types";

/**
 * Evaluation batch persistence.
 *
 * Two idempotency guarantees are enforced here, in SQL rather than in
 * orchestration:
 *  - `EvaluationCaseResult @@unique([batchId, caseKey])` means a redelivered
 *    case job cannot create a second case row;
 *  - `EvaluationResult @@unique([caseResultId, evaluatorKey])` means an
 *    evaluator verdict is written once per case, so a retry overwrites instead
 *    of appending.
 *
 * Counters (`completedCount`, `failedCount`) are incremented with the case's
 * terminal write in one transaction, so progress can never drift from the rows.
 */

function asJson(value: unknown): Prisma.InputJsonValue {
  return (value === undefined ? null : value) as Prisma.InputJsonValue;
}

function asRecord(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseEvaluatorAssignments(value: Prisma.JsonValue): EvaluatorAssignmentSnapshot[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry): EvaluatorAssignmentSnapshot | null => {
      const record = asRecord(entry as Prisma.JsonValue);
      if (record === null) {
        return null;
      }
      const key = record["key"];
      const evaluatorId = record["evaluatorId"];
      const kind = record["kind"];
      const name = record["name"];
      if (
        typeof key !== "string" ||
        typeof evaluatorId !== "string" ||
        typeof kind !== "string" ||
        typeof name !== "string"
      ) {
        return null;
      }
      return {
        key,
        evaluatorId,
        evaluatorVersion: typeof record["evaluatorVersion"] === "number" ? record["evaluatorVersion"] : 1,
        kind: kind as EvaluatorKind,
        name,
        weight: typeof record["weight"] === "number" ? record["weight"] : 0,
        config: asRecord(record["config"] as Prisma.JsonValue) ?? {},
        usesLlm: record["usesLlm"] === true,
      };
    })
    .filter((entry): entry is EvaluatorAssignmentSnapshot => entry !== null);
}

export function parseHarnessSnapshot(value: Prisma.JsonValue): HarnessSnapshot {
  const record = asRecord(value) ?? {};
  return {
    harnessId: typeof record["harnessId"] === "string" ? record["harnessId"] : "",
    harnessVersionId: typeof record["harnessVersionId"] === "string" ? record["harnessVersionId"] : "",
    harnessVersion: typeof record["harnessVersion"] === "number" ? record["harnessVersion"] : 0,
    harnessName: typeof record["harnessName"] === "string" ? record["harnessName"] : "Harness",
    contentHash: typeof record["contentHash"] === "string" ? record["contentHash"] : "",
    entryNode: typeof record["entryNode"] === "string" ? record["entryNode"] : "",
    nodeCount: typeof record["nodeCount"] === "number" ? record["nodeCount"] : 0,
    edgeCount: typeof record["edgeCount"] === "number" ? record["edgeCount"] : 0,
  };
}

function parseDatasetSnapshot(value: Prisma.JsonValue): DatasetCaseSnapshot[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    const record = asRecord(entry as Prisma.JsonValue) ?? {};
    return {
      caseKey: typeof record["caseKey"] === "string" ? record["caseKey"] : "",
      name: typeof record["name"] === "string" ? record["name"] : null,
      input: (record["input"] ?? null) as DatasetCaseSnapshot["input"],
      expectedOutput: (record["expectedOutput"] ?? null) as DatasetCaseSnapshot["expectedOutput"],
      metadata: asRecord((record["metadata"] ?? null) as Prisma.JsonValue) as DatasetCaseSnapshot["metadata"],
      tags: Array.isArray(record["tags"])
        ? record["tags"].filter((tag): tag is string => typeof tag === "string")
        : [],
    };
  });
}

function parseBatchConfig(value: Prisma.JsonValue): BatchConfig {
  const record = asRecord(value) ?? {};
  return {
    concurrency: typeof record["concurrency"] === "number" ? record["concurrency"] : 1,
    limits: asRecord(record["limits"] as Prisma.JsonValue) as BatchConfig["limits"],
  };
}

/** Lenient reader for the metrics JSON — null when it was never computed. */
export function parseBatchMetrics(value: Prisma.JsonValue | null): BatchMetrics | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const cases = asRecord(record["cases"] as Prisma.JsonValue);
  if (cases === null || typeof cases["total"] !== "number") {
    return null;
  }
  const score = asRecord(record["score"] as Prisma.JsonValue) ?? {};
  const latency = asRecord(record["latency"] as Prisma.JsonValue) ?? {};
  const tokens = asRecord(record["tokens"] as Prisma.JsonValue) ?? {};
  const cost = asRecord(record["cost"] as Prisma.JsonValue) ?? {};
  const aggregateStatuses = asRecord(record["aggregateStatuses"] as Prisma.JsonValue) ?? {};
  const perEvaluator = Array.isArray(record["perEvaluator"]) ? (record["perEvaluator"] as unknown[]) : [];
  const evaluatorUsage = asRecord(record["evaluatorUsage"] as Prisma.JsonValue) ?? {};

  const numberOrNull = (value: unknown): number | null => (typeof value === "number" ? value : null);
  const countOrZero = (value: unknown): number => (typeof value === "number" ? value : 0);

  return {
    policy: (record["policy"] === "IGNORE_MISSING" ? "IGNORE_MISSING" : "REQUIRE_ALL") as ScoringPolicy,
    cases: {
      total: countOrZero(cases["total"]),
      completed: countOrZero(cases["completed"]),
      failed: countOrZero(cases["failed"]),
      skipped: countOrZero(cases["skipped"]),
      cancelled: countOrZero(cases["cancelled"]),
      pending: countOrZero(cases["pending"]),
      running: countOrZero(cases["running"]),
    },
    scored: countOrZero(record["scored"]),
    unscored: countOrZero(record["unscored"]),
    aggregateStatuses: {
      complete: countOrZero(aggregateStatuses["complete"]),
      incomplete: countOrZero(aggregateStatuses["incomplete"]),
      failed: countOrZero(aggregateStatuses["failed"]),
    },
    score: { mean: numberOrNull(score["mean"]), median: numberOrNull(score["median"]) },
    passRate: numberOrNull(record["passRate"]),
    passed: countOrZero(record["passed"]),
    failed: countOrZero(record["failed"]),
    latency: {
      averageMs: numberOrNull(latency["averageMs"]),
      medianMs: numberOrNull(latency["medianMs"]),
      measured: countOrZero(latency["measured"]),
    },
    tokens: {
      total: countOrZero(tokens["total"]),
      reported: countOrZero(tokens["reported"]),
      unreported: countOrZero(tokens["unreported"]),
    },
    cost: {
      costUsd: numberOrNull(cost["costUsd"]),
      complete: cost["complete"] === true,
      unpriced: Array.isArray(cost["unpriced"])
        ? (cost["unpriced"] as unknown[]).filter((entry): entry is string => typeof entry === "string")
        : [],
      sources: Array.isArray(cost["sources"])
        ? (cost["sources"] as unknown[]).filter((entry): entry is string => typeof entry === "string")
        : [],
      kind: "estimated",
      billedNote: "estimated",
    },
    retries: countOrZero(record["retries"]),
    toolInvocations: countOrZero(record["toolInvocations"]),
    evaluatorUsage: parseEvaluatorUsage(evaluatorUsage),
    perEvaluator: perEvaluator
      .map((entry): EvaluatorMetric | null => {
        const row = asRecord(entry as Prisma.JsonValue);
        if (row === null || typeof row["evaluatorKey"] !== "string") {
          return null;
        }
        return {
          evaluatorKey: row["evaluatorKey"],
          evaluatorName: typeof row["evaluatorName"] === "string" ? row["evaluatorName"] : row["evaluatorKey"],
          kind: typeof row["kind"] === "string" ? row["kind"] : "unknown",
          scored: countOrZero(row["scored"]),
          errors: countOrZero(row["errors"]),
          skipped: countOrZero(row["skipped"]),
          meanScore: numberOrNull(row["meanScore"]),
          passRate: numberOrNull(row["passRate"]),
          meanDurationMs: numberOrNull(row["meanDurationMs"]),
        };
      })
      .filter((entry): entry is EvaluatorMetric => entry !== null),
  };
}

/** Judge usage as stored in the metrics JSON (never re-derived from a guess). */
function parseEvaluatorUsage(
  value: Record<string, unknown>,
): BatchMetrics["evaluatorUsage"] {
  const num = (key: string): number => (typeof value[key] === "number" ? (value[key] as number) : 0);
  return {
    calls: num("calls"),
    promptTokens: num("promptTokens"),
    completionTokens: num("completionTokens"),
    totalTokens: num("totalTokens"),
    costUsd: typeof value["costUsd"] === "number" ? value["costUsd"] : null,
    unknownCost: value["unknownCost"] === true,
  };
}

function toBatch(row: {
  id: string;
  projectId: string;
  label: string | null;
  agentId: string;
  harnessId: string;
  harnessVersionId: string;
  datasetId: string;
  datasetVersionId: string;
  datasetSnapshot: Prisma.JsonValue;
  evaluatorConfig: Prisma.JsonValue;
  harnessSnapshot: Prisma.JsonValue;
  scoringPolicy: string;
  passThreshold: number | null;
  status: string;
  caseCount: number;
  completedCount: number;
  failedCount: number;
  metrics: Prisma.JsonValue | null;
  config: Prisma.JsonValue;
  cancelRequestedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}): EvaluationBatchRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    label: row.label,
    agentId: row.agentId,
    harnessId: row.harnessId,
    harnessVersionId: row.harnessVersionId,
    datasetId: row.datasetId,
    datasetVersionId: row.datasetVersionId,
    datasetSnapshot: parseDatasetSnapshot(row.datasetSnapshot),
    evaluatorConfig: parseEvaluatorAssignments(row.evaluatorConfig),
    harnessSnapshot: parseHarnessSnapshot(row.harnessSnapshot),
    scoringPolicy: row.scoringPolicy === "IGNORE_MISSING" ? "IGNORE_MISSING" : "REQUIRE_ALL",
    passThreshold: row.passThreshold,
    status: row.status as BatchStatus,
    caseCount: row.caseCount,
    completedCount: row.completedCount,
    failedCount: row.failedCount,
    metrics: parseBatchMetrics(row.metrics),
    config: parseBatchConfig(row.config),
    cancelRequestedAt: row.cancelRequestedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toCase(row: {
  id: string;
  batchId: string;
  caseKey: string;
  index: number;
  name: string | null;
  status: string;
  runId: string | null;
  inputPreview: string | null;
  expectedOutput: Prisma.JsonValue | null;
  tags: string[];
  aggregateScore: number | null;
  aggregateStatus: string | null;
  error: Prisma.JsonValue | null;
  attempts: number;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): EvaluationCaseRecord {
  return {
    id: row.id,
    batchId: row.batchId,
    caseKey: row.caseKey,
    index: row.index,
    name: row.name,
    status: row.status as CaseStatus,
    runId: row.runId,
    inputPreview: row.inputPreview,
    expectedOutput: row.expectedOutput,
    tags: row.tags,
    aggregateScore: row.aggregateScore,
    aggregateStatus: (row.aggregateStatus as AggregateStatus | null) ?? null,
    error: asRecord(row.error),
    attempts: row.attempts,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toResult(row: {
  id: string;
  batchId: string | null;
  caseResultId: string | null;
  runId: string | null;
  evaluatorId: string | null;
  evaluatorVersion: number | null;
  evaluatorKey: string;
  evaluatorName: string;
  kind: string;
  status: string;
  score: number | null;
  maxScore: number;
  normalizedScore: number | null;
  passed: boolean | null;
  explanation: string | null;
  evidence: Prisma.JsonValue | null;
  durationMs: number | null;
  metadata: Prisma.JsonValue | null;
  createdAt: Date;
}): EvaluationResultView {
  return {
    id: row.id,
    batchId: row.batchId,
    caseResultId: row.caseResultId,
    runId: row.runId,
    evaluatorId: row.evaluatorId,
    evaluatorVersion: row.evaluatorVersion,
    evaluatorKey: row.evaluatorKey,
    evaluatorName: row.evaluatorName,
    kind: row.kind as EvaluatorKind,
    status: row.status as EvaluationResultRecord["status"],
    score: row.score,
    maxScore: row.maxScore,
    normalizedScore: row.normalizedScore,
    passed: row.passed,
    explanation: row.explanation ?? "",
    evidence: asRecord(row.evidence),
    durationMs: row.durationMs ?? 0,
    metadata: asRecord(row.metadata),
    createdAt: row.createdAt,
  };
}

export interface CreateBatchInput {
  projectId: string;
  label: string | null;
  agentId: string;
  harnessId: string;
  harnessVersionId: string;
  datasetId: string;
  datasetVersionId: string;
  datasetSnapshot: DatasetCaseSnapshot[];
  evaluatorConfig: EvaluatorAssignmentSnapshot[];
  harnessSnapshot: HarnessSnapshot;
  scoringPolicy: ScoringPolicy;
  passThreshold: number | null;
  config: BatchConfig;
  createdBy: string | null;
}

export interface ListBatchInput {
  projectIds: string[];
  harnessId?: string;
  datasetId?: string;
  status?: BatchStatus[];
  limit?: number;
  offset?: number;
}

export const evaluationRepository = {
  /**
   * Creates the batch and one PENDING case row per dataset case in a single
   * transaction, so a batch can never exist with a partial case set.
   */
  async createBatch(input: CreateBatchInput): Promise<EvaluationBatchRecord> {
    const row = await getPrisma().evaluationBatch.create({
      data: {
        projectId: input.projectId,
        label: input.label,
        agentId: input.agentId,
        harnessId: input.harnessId,
        harnessVersionId: input.harnessVersionId,
        datasetId: input.datasetId,
        datasetVersionId: input.datasetVersionId,
        datasetSnapshot: input.datasetSnapshot as unknown as Prisma.InputJsonValue,
        evaluatorConfig: input.evaluatorConfig as unknown as Prisma.InputJsonValue,
        harnessSnapshot: input.harnessSnapshot as unknown as Prisma.InputJsonValue,
        scoringPolicy: input.scoringPolicy,
        passThreshold: input.passThreshold,
        status: "PENDING",
        caseCount: input.datasetSnapshot.length,
        config: input.config as unknown as Prisma.InputJsonValue,
        createdBy: input.createdBy,
        cases: {
          create: input.datasetSnapshot.map((entry, index) => ({
            caseKey: entry.caseKey,
            index,
            name: entry.name,
            inputPreview: preview(entry.input),
            expectedOutput:
              entry.expectedOutput === null
                ? undefined
                : (entry.expectedOutput as Prisma.InputJsonValue),
            tags: entry.tags,
          })),
        },
      },
    });
    return toBatch(row);
  },

  async findById(batchId: string): Promise<EvaluationBatchRecord | null> {
    const row = await getPrisma().evaluationBatch.findUnique({ where: { id: batchId } });
    return row ? toBatch(row) : null;
  },

  /** Batch + its project-scoped labels (agent/harness/dataset). */
  async findDetail(batchId: string): Promise<{
    batch: EvaluationBatchRecord;
    agent: { id: string; name: string } | null;
    harness: { id: string; name: string; slug: string } | null;
    dataset: { id: string; name: string; slug: string; version: number } | null;
  } | null> {
    const row = await getPrisma().evaluationBatch.findUnique({
      where: { id: batchId },
      include: {
        agent: { select: { id: true, name: true } },
        harness: { select: { id: true, name: true, slug: true } },
        dataset: { select: { id: true, name: true, slug: true, currentVersion: true } },
        datasetVersion: { select: { version: true } },
      },
    });
    if (row === null) {
      return null;
    }
    return {
      batch: toBatch(row),
      agent: row.agent,
      harness: row.harness,
      dataset:
        row.dataset === null
          ? null
          : {
              id: row.dataset.id,
              name: row.dataset.name,
              slug: row.dataset.slug,
              version: row.datasetVersion?.version ?? row.dataset.currentVersion,
            },
    };
  },

  async list(input: ListBatchInput): Promise<{ items: BatchListItem[]; total: number; limit: number; offset: number }> {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const offset = Math.max(input.offset ?? 0, 0);
    const where: Prisma.EvaluationBatchWhereInput = {
      projectId: { in: input.projectIds },
      ...(input.harnessId !== undefined ? { harnessId: input.harnessId } : {}),
      ...(input.datasetId !== undefined ? { datasetId: input.datasetId } : {}),
      ...(input.status !== undefined && input.status.length > 0
        ? { status: { in: input.status } }
        : {}),
    };

    const prisma = getPrisma();
    const [total, rows] = await Promise.all([
      prisma.evaluationBatch.count({ where }),
      prisma.evaluationBatch.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
        include: {
          harness: { select: { name: true } },
          dataset: { select: { name: true } },
          datasetVersion: { select: { version: true } },
        },
      }),
    ]);

    const items: BatchListItem[] = rows.map((row) => {
      const metrics = parseBatchMetrics(row.metrics);
      return {
        id: row.id,
        label: row.label,
        status: row.status as BatchStatus,
        harnessId: row.harnessId,
        harnessName: row.harness.name,
        harnessVersionLabel: parseHarnessSnapshot(row.harnessSnapshot).harnessVersion,
        datasetId: row.datasetId,
        datasetName: row.dataset.name,
        datasetVersion: row.datasetVersion.version,
        caseCount: row.caseCount,
        completedCount: row.completedCount,
        failedCount: row.failedCount,
        meanScore: metrics?.score.mean ?? null,
        passRate: metrics?.passRate ?? null,
        costUsd: metrics?.cost.costUsd ?? null,
        costKind: "estimated",
        createdAt: row.createdAt,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
      };
    });

    return { items, total, limit, offset };
  },

  async updateStatus(
    batchId: string,
    input: { status: BatchStatus; startedAt?: Date | null; completedAt?: Date | null },
  ): Promise<void> {
    await getPrisma().evaluationBatch.update({
      where: { id: batchId },
      data: {
        status: input.status,
        ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
        ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
      },
    });
  },

  async saveMetrics(batchId: string, metrics: BatchMetrics): Promise<void> {
    await getPrisma().evaluationBatch.update({
      where: { id: batchId },
      data: { metrics: metrics as unknown as Prisma.InputJsonValue },
    });
  },

  /**
   * An in-flight batch for the exact same experiment, if one exists. Starting a
   * second identical batch would spend the same tokens twice and make the
   * comparison view ambiguous, so the service refuses it.
   */
  async findInFlight(
    harnessVersionId: string,
    datasetVersionId: string,
  ): Promise<{ id: string } | null> {
    return getPrisma().evaluationBatch.findFirst({
      where: {
        harnessVersionId,
        datasetVersionId,
        status: { in: ["PENDING", "RUNNING"] },
      },
      select: { id: true },
    });
  },

  async requestCancellation(batchId: string): Promise<void> {
    await getPrisma().evaluationBatch.updateMany({
      where: { id: batchId, status: { in: ["PENDING", "RUNNING"] } },
      data: { cancelRequestedAt: new Date() },
    });
  },

  /**
   * Atomically claims a PENDING case for execution. Returns null when another
   * worker already claimed it (or the case is done) — the caller must then do
   * nothing, which is what makes redelivery harmless.
   */
  async claimCase(batchId: string, caseKey: string): Promise<EvaluationCaseRecord | null> {
    const prisma = getPrisma();
    const claimed = await prisma.evaluationCaseResult.updateMany({
      where: { batchId, caseKey, status: "PENDING" },
      data: { status: "RUNNING", startedAt: new Date(), attempts: { increment: 1 } },
    });
    if (claimed.count === 0) {
      return null;
    }
    const row = await prisma.evaluationCaseResult.findUnique({
      where: { batchId_caseKey: { batchId, caseKey } },
    });
    return row ? toCase(row) : null;
  },

  async getCase(caseId: string): Promise<EvaluationCaseRecord | null> {
    const row = await getPrisma().evaluationCaseResult.findUnique({ where: { id: caseId } });
    return row ? toCase(row) : null;
  },

  async findCase(batchId: string, caseKey: string): Promise<EvaluationCaseRecord | null> {
    const row = await getPrisma().evaluationCaseResult.findUnique({
      where: { batchId_caseKey: { batchId, caseKey } },
    });
    return row ? toCase(row) : null;
  },

  /** Records the run a case produced (before evaluation starts). */
  async attachRun(caseId: string, runId: string): Promise<void> {
    await getPrisma().evaluationCaseResult.update({
      where: { id: caseId },
      data: { runId },
    });
  },

  /**
   * Writes a case's terminal state and increments the batch counters in one
   * transaction. `completed` counts scored cases; `failed` counts cases that
   * produced no usable result.
   */
  async completeCase(
    batchId: string,
    caseId: string,
    input: {
      status: Extract<CaseStatus, "COMPLETED" | "FAILED" | "SKIPPED" | "CANCELLED">;
      runId?: string | null;
      aggregateScore?: number | null;
      aggregateStatus?: AggregateStatus | null;
      error?: Record<string, unknown> | null;
      incrementCompleted: boolean;
      incrementFailed: boolean;
    },
  ): Promise<void> {
    const prisma = getPrisma();
    const operations: Prisma.PrismaPromise<unknown>[] = [
      prisma.evaluationCaseResult.update({
        where: { id: caseId },
        data: {
          status: input.status,
          completedAt: new Date(),
          ...(input.runId !== undefined ? { runId: input.runId } : {}),
          ...(input.aggregateScore !== undefined ? { aggregateScore: input.aggregateScore } : {}),
          ...(input.aggregateStatus !== undefined ? { aggregateStatus: input.aggregateStatus } : {}),
          ...(input.error !== undefined
            ? { error: input.error === null ? Prisma.JsonNull : asJson(input.error) }
            : {}),
        },
      }),
    ];
    if (input.incrementCompleted || input.incrementFailed) {
      operations.push(
        prisma.evaluationBatch.update({
          where: { id: batchId },
          data: {
            ...(input.incrementCompleted ? { completedCount: { increment: 1 } } : {}),
            ...(input.incrementFailed ? { failedCount: { increment: 1 } } : {}),
          },
        }),
      );
    }
    await prisma.$transaction(operations);
  },

  /** Returns a case to PENDING so it can be retried (explicit user action). */
  async resetCaseForRetry(batchId: string, caseKey: string): Promise<void> {
    await getPrisma().evaluationCaseResult.updateMany({
      where: { batchId, caseKey, status: { in: ["FAILED", "CANCELLED"] } },
      data: { status: "PENDING", error: Prisma.JsonNull, completedAt: null },
    });
  },

  async listCases(
    batchId: string,
    options: { status?: CaseStatus[]; limit?: number; offset?: number } = {},
  ): Promise<{ cases: EvaluationCaseRecord[]; total: number; limit: number; offset: number }> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);
    const where: Prisma.EvaluationCaseResultWhereInput = {
      batchId,
      ...(options.status !== undefined && options.status.length > 0
        ? { status: { in: options.status } }
        : {}),
    };
    const prisma = getPrisma();
    const [total, rows] = await Promise.all([
      prisma.evaluationCaseResult.count({ where }),
      prisma.evaluationCaseResult.findMany({
        where,
        orderBy: { index: "asc" },
        take: limit,
        skip: offset,
      }),
    ]);
    return { cases: rows.map(toCase), total, limit, offset };
  },

  async countsByStatus(batchId: string): Promise<Record<CaseStatus, number>> {
    const rows = await getPrisma().evaluationCaseResult.groupBy({
      by: ["status"],
      where: { batchId },
      _count: { _all: true },
    });
    const counts: Record<CaseStatus, number> = {
      PENDING: 0,
      RUNNING: 0,
      COMPLETED: 0,
      FAILED: 0,
      SKIPPED: 0,
      CANCELLED: 0,
    };
    for (const row of rows) {
      counts[row.status as CaseStatus] = row._count._all;
    }
    return counts;
  },

  /**
   * Upserts evaluator verdicts for one case. The unique key is
   * (caseResultId, evaluatorKey), so a redelivered job converges on the same
   * row instead of appending a duplicate score.
   */
  async saveResults(
    entries: Array<{
      batchId: string | null;
      caseResultId: string | null;
      runId: string | null;
      result: EvaluationResultRecord;
    }>,
  ): Promise<EvaluationResultView[]> {
    if (entries.length === 0) {
      return [];
    }
    const prisma = getPrisma();
    const views: EvaluationResultView[] = [];
    for (const entry of entries) {
      const data = {
        batchId: entry.batchId,
        runId: entry.runId,
        evaluatorId: entry.result.evaluatorId,
        evaluatorVersion: entry.result.evaluatorVersion,
        evaluatorKey: entry.result.evaluatorKey,
        evaluatorName: entry.result.evaluatorName,
        kind: entry.result.kind,
        status: entry.result.status,
        score: entry.result.score,
        maxScore: entry.result.maxScore,
        normalizedScore: entry.result.normalizedScore,
        passed: entry.result.passed,
        explanation: entry.result.explanation,
        evidence: entry.result.evidence === null ? Prisma.JsonNull : asJson(entry.result.evidence),
        durationMs: entry.result.durationMs,
        metadata: entry.result.metadata === null ? Prisma.JsonNull : asJson(entry.result.metadata),
      };
      const row =
        entry.caseResultId === null
          ? await prisma.evaluationResult.create({ data: { ...data, caseResultId: null } })
          : await prisma.evaluationResult.upsert({
              where: {
                caseResultId_evaluatorKey: {
                  caseResultId: entry.caseResultId,
                  evaluatorKey: entry.result.evaluatorKey,
                },
              },
              create: { ...data, caseResultId: entry.caseResultId },
              update: {
                runId: entry.runId,
                status: data.status,
                score: data.score,
                normalizedScore: data.normalizedScore,
                passed: data.passed,
                explanation: data.explanation,
                evidence: data.evidence,
                durationMs: data.durationMs,
                metadata: data.metadata,
              },
            });
      views.push(toResult(row));
    }
    return views;
  },

  /**
   * Standalone run evaluations are replaced atomically: results are keyed by
   * (runId, evaluatorKey) and Postgres treats NULL caseResultId values as
   * distinct, so the delete+insert has to be explicit to stay idempotent.
   */
  async replaceRunResults(
    runId: string,
    entries: Array<{ result: EvaluationResultRecord; weight: number }>,
  ): Promise<EvaluationResultView[]> {
    const prisma = getPrisma();
    await prisma.evaluationResult.deleteMany({ where: { runId, caseResultId: null } });
    if (entries.length === 0) {
      return [];
    }
    const rows = await prisma.$transaction(
      entries.map((entry) =>
        prisma.evaluationResult.create({
          data: {
            runId,
            batchId: null,
            caseResultId: null,
            evaluatorId: entry.result.evaluatorId,
            evaluatorVersion: entry.result.evaluatorVersion,
            evaluatorKey: entry.result.evaluatorKey,
            evaluatorName: entry.result.evaluatorName,
            kind: entry.result.kind,
            status: entry.result.status,
            score: entry.result.score,
            maxScore: entry.result.maxScore,
            normalizedScore: entry.result.normalizedScore,
            passed: entry.result.passed,
            explanation: entry.result.explanation,
            evidence: entry.result.evidence === null ? Prisma.JsonNull : asJson(entry.result.evidence),
            durationMs: entry.result.durationMs,
            metadata:
              entry.result.metadata === null
                ? asJson({ weight: entry.weight })
                : asJson({ ...entry.result.metadata, weight: entry.weight }),
          },
        }),
      ),
    );
    return rows.map(toResult);
  },

  async listResultsForCase(caseId: string): Promise<EvaluationResultView[]> {
    const rows = await getPrisma().evaluationResult.findMany({
      where: { caseResultId: caseId },
      orderBy: { evaluatorKey: "asc" },
    });
    return rows.map(toResult);
  },

  async listResultsForRun(runId: string): Promise<EvaluationResultView[]> {
    const rows = await getPrisma().evaluationResult.findMany({
      where: { runId },
      orderBy: [{ createdAt: "desc" }, { evaluatorKey: "asc" }],
    });
    return rows.map(toResult);
  },

  /**
   * All case results of a batch with their result rows (batched, no N+1).
   * `passThreshold` comes from the batch, because pass/fail is derived at read
   * time rather than frozen into the case row.
   */
  async listCaseResultsWithResults(batchId: string, passThreshold: number | null): Promise<
    Array<{
      caseKey: string;
      index: number;
      status: string;
      aggregateScore: number | null;
      aggregateStatus: string | null;
      runId: string | null;
      passed: boolean | null;
      results: EvaluationResultView[];
    }>
  > {
    const rows = await getPrisma().evaluationCaseResult.findMany({
      where: { batchId },
      orderBy: { index: "asc" },
      include: { results: { orderBy: { evaluatorKey: "asc" } } },
    });
    return rows.map((row) => ({
      caseKey: row.caseKey,
      index: row.index,
      status: row.status,
      aggregateScore: row.aggregateScore,
      aggregateStatus: row.aggregateStatus,
      runId: row.runId,
      passed: derivedPassed(row.aggregateScore, row.aggregateStatus, passThreshold),
      results: row.results.map(toResult),
    }));
  },

  /** Everything `computeBatchMetrics` needs, in three queries. */
  async listCaseMetricRows(batchId: string, passThreshold: number | null): Promise<BatchCaseMetricRow[]> {
    const prisma = getPrisma();
    const rows = await prisma.evaluationCaseResult.findMany({
      where: { batchId },
      orderBy: { index: "asc" },
      // `EvaluationCaseResult.runId` is an indexed link rather than a relation
      // (evaluation records deliberately outlive run rows), so the run is
      // joined manually below — one query for all cases, never per row.
      include: { results: true },
    });

    const runIds = rows.map((row) => row.runId).filter((id): id is string => id !== null);
    const runs =
      runIds.length === 0
        ? []
        : await prisma.run.findMany({
            where: { id: { in: runIds } },
            select: {
              id: true,
              attempt: true,
              latencyMs: true,
              tokenUsage: true,
              usage: true,
            },
          });
    const runById = new Map(runs.map((run) => [run.id, run]));
    const toolCallsByRun =
      runIds.length === 0
        ? []
        : await prisma.runStep.groupBy({
            by: ["runId"],
            where: { runId: { in: runIds }, nodeType: "tool" },
            _count: { _all: true },
          });
    const toolCalls = new Map(toolCallsByRun.map((row) => [row.runId, row._count._all]));

    return rows.map((row) => {
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
        status: row.status as BatchCaseMetricRow["status"],
        aggregateScore: row.aggregateScore,
        aggregateStatus: (row.aggregateStatus as AggregateStatus | null) ?? null,
        passed: derivedPassed(row.aggregateScore, row.aggregateStatus, passThreshold),
        latencyMs: run?.latencyMs ?? null,
        totalTokens: typeof tokenUsage?.totalTokens === "number" ? tokenUsage.totalTokens : null,
        attempt: run?.attempt ?? 0,
        toolCalls: row.runId === null ? 0 : (toolCalls.get(row.runId) ?? 0),
        usage,
        results: row.results.map(toResult),
      };
    });
  },
};

/**
 * A case's pass verdict is derived, never stored: the aggregate must have
 * covered everything it was asked to score (COMPLETE), and — when the batch
 * defined one — the score must clear the threshold. An INCOMPLETE or FAILED
 * aggregate has no verdict at all rather than a default of "failed".
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

/** Preview of a dataset case input for list rows. */
function preview(value: unknown, maxLength = 160): string {
  const text = typeof value === "string" ? value : safeStringify(value);
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > maxLength ? `${single.slice(0, maxLength - 1)}…` : single;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
