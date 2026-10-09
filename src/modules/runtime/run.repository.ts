import type { Prisma } from "@/generated/prisma/client";
import { getPrisma } from "@/lib/db/prisma";
import type { RuntimeErrorPayload } from "./errors/runtime-error";
import type { RuntimeEvent } from "./events/events";
import type { RunMetadata, RuntimeUsageRecord } from "./run.types";
import type {
  PersistedRuntimeEvent,
  Run,
  RunListFilters,
  RunListPage,
  RunListItem,
  RunStatus,
  RunStep,
  RunStepStatus,
  RunWithSteps,
  TokenUsage,
} from "./run.types";
import type { ExecutionStep } from "./state/execution-state";

/**
 * Run persistence.
 *
 * Write pattern during execution (chosen for durability over maximum batching):
 *  - the run row is created before enqueueing and re-read by the executor;
 *  - `claimForExecution` atomically moves QUEUED → RUNNING so two workers can
 *    never execute the same run twice;
 *  - steps are inserted when they start and updated when they finish (a crash
 *    leaves an honest RUNNING row rather than losing the step);
 *  - run-level events are appended in batches at the end of the run, steps keep
 *    a per-step Trace document;
 *  - usage is written once per (provider, model) with an upsert.
 */

function toRuntimeError(value: Prisma.JsonValue | null): RuntimeErrorPayload | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate["code"] !== "string" || typeof candidate["message"] !== "string") {
    return null;
  }
  return {
    code: candidate["code"] as RuntimeErrorPayload["code"],
    message: candidate["message"],
    ...(typeof candidate["nodeId"] === "string" ? { nodeId: candidate["nodeId"] } : {}),
    retryable: candidate["retryable"] === true,
  };
}

function toTokenUsage(value: Prisma.JsonValue | null): TokenUsage | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const promptTokens = candidate["promptTokens"];
  const completionTokens = candidate["completionTokens"];
  const totalTokens = candidate["totalTokens"];
  if (
    typeof promptTokens !== "number" ||
    typeof completionTokens !== "number" ||
    typeof totalTokens !== "number"
  ) {
    return null;
  }
  return { promptTokens, completionTokens, totalTokens };
}

function toRunMetadata(value: Prisma.JsonValue | null): RunMetadata | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate["engineVersion"] !== "string") {
    return null;
  }
  return value as unknown as RunMetadata;
}

type RunRow = {
  id: string;
  harnessId: string;
  harnessVersionId: string;
  agentId: string | null;
  agentVersion: number | null;
  status: string;
  input: Prisma.JsonValue;
  output: Prisma.JsonValue | null;
  tokenUsage: Prisma.JsonValue | null;
  cost: number | null;
  latencyMs: number | null;
  error: Prisma.JsonValue | null;
  metadata: Prisma.JsonValue | null;
  attempt: number;
  retryOfRunId: string | null;
  cancelRequestedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
};

export function toRun(row: RunRow): Run {
  return {
    id: row.id,
    harnessId: row.harnessId,
    harnessVersionId: row.harnessVersionId,
    agentId: row.agentId,
    agentVersion: row.agentVersion,
    status: row.status as RunStatus,
    input: row.input,
    output: row.output,
    tokenUsage: toTokenUsage(row.tokenUsage),
    cost: row.cost,
    latencyMs: row.latencyMs,
    error: toRuntimeError(row.error),
    metadata: toRunMetadata(row.metadata),
    attempt: row.attempt,
    retryOfRunId: row.retryOfRunId,
    cancelRequestedAt: row.cancelRequestedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
  };
}

function toRunStep(row: {
  id: string;
  runId: string;
  index: number;
  nodeId: string;
  nodeType: string;
  nodeLabel: string;
  status: string;
  input: Prisma.JsonValue | null;
  output: Prisma.JsonValue | null;
  error: Prisma.JsonValue | null;
  metadata: Prisma.JsonValue | null;
  iteration: number | null;
  startedAt: Date | null;
  completedAt: Date | null;
  durationMs: number | null;
  createdAt: Date;
}): RunStep {
  return {
    id: row.id,
    runId: row.runId,
    index: row.index,
    nodeId: row.nodeId,
    nodeType: row.nodeType,
    nodeLabel: row.nodeLabel,
    status: row.status as RunStepStatus,
    input: row.input,
    output: row.output,
    error: toRuntimeError(row.error),
    metadata:
      row.metadata !== null && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : null,
    iteration: row.iteration,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    durationMs: row.durationMs,
    createdAt: row.createdAt,
  };
}

const RUN_STATUS_TO_STEP_STATUS: Record<RunStatus, RunStepStatus> = {
  QUEUED: "PENDING",
  RUNNING: "RUNNING",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  CANCELLED: "SKIPPED",
  TIMED_OUT: "FAILED",
};

function asJson(value: unknown): Prisma.InputJsonValue {
  return (value === undefined ? null : value) as Prisma.InputJsonValue;
}

function preview(value: unknown, maxLength = 160): string {
  if (value === null || value === undefined) {
    return "";
  }
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

export interface CreateRunRowInput {
  harnessId: string;
  harnessVersionId: string;
  input: unknown;
  agentId: string;
  agentVersion: number | null;
  metadata: RunMetadata;
  attempt?: number;
  retryOfRunId?: string | null;
}

export interface ListRunsInput extends RunListFilters {
  /** Restrict to the given harness ids (ownership scoping happens in the service). */
  harnessIds?: string[];
  agentIds?: string[];
}

export const runRepository = {
  async create(input: CreateRunRowInput): Promise<Run> {
    const row = await getPrisma().run.create({
      data: {
        harnessId: input.harnessId,
        harnessVersionId: input.harnessVersionId,
        agentId: input.agentId,
        agentVersion: input.agentVersion,
        status: "QUEUED",
        input: asJson(input.input),
        metadata: input.metadata as unknown as Prisma.InputJsonValue,
        attempt: input.attempt ?? 1,
        retryOfRunId: input.retryOfRunId ?? null,
      },
    });
    return toRun(row);
  },

  async findById(runId: string): Promise<Run | null> {
    const row = await getPrisma().run.findUnique({ where: { id: runId } });
    return row ? toRun(row) : null;
  },

  /**
   * Atomically claims a queued run for execution.
   * Returns null when another worker got there first (or the run was cancelled
   * before it started) — the caller must then do nothing.
   */
  async claimForExecution(runId: string, startedAt: Date): Promise<Run | null> {
    const result = await getPrisma().run.updateMany({
      where: { id: runId, status: "QUEUED" },
      data: { status: "RUNNING", startedAt },
    });
    if (result.count === 0) {
      return null;
    }
    return this.findById(runId);
  },

  async findByIdWithSteps(runId: string): Promise<RunWithSteps | null> {
    const row = await getPrisma().run.findUnique({
      where: { id: runId },
      include: {
        steps: { orderBy: { index: "asc" } },
        usage: { orderBy: { totalTokens: "desc" } },
      },
    });
    if (row === null) {
      return null;
    }
    return {
      ...toRun(row),
      steps: row.steps.map(toRunStep),
      usage: row.usage.map((entry) => ({
        provider: entry.provider,
        model: entry.model,
        calls: entry.calls,
        promptTokens: entry.promptTokens,
        completionTokens: entry.completionTokens,
        totalTokens: entry.totalTokens,
        costUsd: entry.costUsd,
      })),
    };
  },

  async listEvents(runId: string, limit = 500): Promise<PersistedRuntimeEvent[]> {
    const rows = await getPrisma().runtimeEvent.findMany({
      where: { runId },
      orderBy: { seq: "asc" },
      take: limit,
    });
    return rows.map((row) => ({
      seq: row.seq,
      type: row.type,
      payload: row.payload as unknown as RuntimeEvent,
      at: row.at,
    }));
  },

  async list(input: ListRunsInput): Promise<RunListPage> {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    const offset = Math.max(input.offset ?? 0, 0);
    const statuses = input.status === undefined
      ? undefined
      : Array.isArray(input.status)
        ? input.status
        : [input.status];

    const where: Prisma.RunWhereInput = {
      ...(input.harnessId !== undefined ? { harnessId: input.harnessId } : {}),
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      ...(statuses !== undefined ? { status: { in: statuses } } : {}),
      ...(input.since !== undefined || input.until !== undefined
        ? {
            createdAt: {
              ...(input.since !== undefined ? { gte: input.since } : {}),
              ...(input.until !== undefined ? { lte: input.until } : {}),
            },
          }
        : {}),
      ...(input.harnessIds !== undefined ? { harnessId: { in: input.harnessIds } } : {}),
      ...(input.agentIds !== undefined ? { agentId: { in: input.agentIds } } : {}),
    };

    const prisma = getPrisma();
    const [total, rows] = await Promise.all([
      prisma.run.count({ where }),
      prisma.run.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
        include: {
          harness: { select: { name: true } },
          harnessVersion: { select: { version: true } },
          _count: { select: { steps: true } },
        },
      }),
    ]);

    const agentIds = [
      ...new Set(rows.map((row) => row.agentId).filter((id): id is string => id !== null)),
    ];
    const agents =
      agentIds.length === 0
        ? []
        : await prisma.agent.findMany({
            where: { id: { in: agentIds } },
            select: { id: true, name: true },
          });
    const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));

    const runs: RunListItem[] = rows.map((row) => {
      const usage = toTokenUsage(row.tokenUsage);
      return {
        id: row.id,
        status: row.status as RunStatus,
        harnessId: row.harnessId,
        harnessName: row.harness.name,
        harnessVersionLabel: row.harnessVersion.version,
        agentId: row.agentId,
        agentName: row.agentId === null ? null : (agentNames.get(row.agentId) ?? null),
        attempt: row.attempt,
        retryOfRunId: row.retryOfRunId,
        inputPreview: preview(row.input),
        outputPreview: preview(row.output),
        errorCode: toRuntimeError(row.error)?.code ?? null,
        totalTokens: usage?.totalTokens ?? 0,
        cost: row.cost,
        costKnown: row.cost !== null,
        durationMs:
          row.latencyMs ??
          (row.startedAt !== null && row.completedAt !== null
            ? row.completedAt.getTime() - row.startedAt.getTime()
            : null),
        stepCount: row._count.steps,
        createdAt: row.createdAt,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
      };
    });

    return { runs, total, limit, offset };
  },

  /** Marks the run as running (used by the inline dispatcher before execution). */
  async markRunning(runId: string, startedAt: Date): Promise<void> {
    await getPrisma().run.updateMany({
      where: { id: runId, status: "QUEUED" },
      data: { status: "RUNNING", startedAt },
    });
  },

  async updateStatus(
    runId: string,
    input: {
      status: RunStatus;
      startedAt?: Date | null;
      completedAt?: Date | null;
      output?: unknown;
      error?: RuntimeErrorPayload | null;
      tokenUsage?: TokenUsage | null;
      cost?: number | null;
      latencyMs?: number | null;
      metadata?: RunMetadata;
    },
  ): Promise<void> {
    await getPrisma().run.update({
      where: { id: runId },
      data: {
        status: input.status,
        ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
        ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
        ...(input.output !== undefined ? { output: asJson(input.output) } : {}),
        ...(input.error !== undefined ? { error: asJson(input.error) } : {}),
        ...(input.tokenUsage !== undefined ? { tokenUsage: asJson(input.tokenUsage) } : {}),
        ...(input.cost !== undefined ? { cost: input.cost } : {}),
        ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
        ...(input.metadata !== undefined
          ? { metadata: input.metadata as unknown as Prisma.InputJsonValue }
          : {}),
      },
    });
  },

  /** Updates only the metadata snapshot — used after dispatch mode is known. */
  async updateMetadata(runId: string, metadata: RunMetadata): Promise<void> {
    await getPrisma().run.update({
      where: { id: runId },
      data: { metadata: metadata as unknown as Prisma.InputJsonValue },
    });
  },

  async requestCancellation(runId: string): Promise<void> {
    await getPrisma().run.updateMany({
      where: { id: runId, status: { in: ["QUEUED", "RUNNING"] } },
      data: { cancelRequestedAt: new Date() },
    });
  },

  /** Index of the next step row for a run (steps are unique per run+index). */
  async nextStepIndex(runId: string): Promise<number> {
    const last = await getPrisma().runStep.findFirst({
      where: { runId },
      orderBy: { index: "desc" },
      select: { index: true },
    });
    return (last?.index ?? -1) + 1;
  },

  async insertStep(
    runId: string,
    index: number,
    step: ExecutionStep,
  ): Promise<string> {
    const row = await getPrisma().runStep.create({
      data: {
        runId,
        index,
        nodeId: step.nodeId,
        nodeType: step.nodeType,
        nodeLabel: step.nodeLabel,
        status: RUN_STATUS_TO_STEP_STATUS.RUNNING,
        input: asJson(step.input),
        startedAt: step.startedAt,
      },
      select: { id: true },
    });
    return row.id;
  },

  async completeStep(stepRowId: string, step: ExecutionStep): Promise<void> {
    await getPrisma().runStep.update({
      where: { id: stepRowId },
      data: {
        status:
          step.status === "succeeded"
            ? "SUCCEEDED"
            : step.status === "skipped"
              ? "SKIPPED"
              : step.status === "failed"
                ? "FAILED"
                : "RUNNING",
        output: asJson(step.output),
        error: asJson(step.error),
        metadata: asJson(step.metadata),
        ...(typeof step.metadata["iteration"] === "number"
          ? { iteration: step.metadata["iteration"] }
          : {}),
        completedAt: step.completedAt,
        durationMs: step.durationMs,
      },
    });
  },

  async saveTrace(stepRowId: string, events: unknown): Promise<void> {
    await getPrisma().trace.upsert({
      where: { runStepId: stepRowId },
      create: { runStepId: stepRowId, events: asJson(events) },
      update: { events: asJson(events) },
    });
  },

  /**
   * Writes every step's trace document in one round trip.
   *
   * Traces are buffered during execution and flushed once at the end: the
   * per-step writes that matter for correctness (step rows) stay immediate,
   * while the trace documents — which are only read after the run finishes —
   * cost one query instead of one per step.
   */
  async saveTraces(entries: Array<{ stepRowId: string; events: unknown }>): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    await getPrisma().trace.createMany({
      data: entries.map((entry) => ({
        runStepId: entry.stepRowId,
        events: asJson(entry.events),
      })),
      skipDuplicates: true,
    });
  },

  /** Appends run-level events (idempotent per (runId, seq)). */
  async appendEvents(runId: string, events: RuntimeEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    await getPrisma().runtimeEvent.createMany({
      data: events.map((event) => ({
        runId,
        seq: event.seq,
        type: event.type,
        payload: event as unknown as Prisma.InputJsonValue,
        at: new Date(event.at),
      })),
      skipDuplicates: true,
    });
  },

  async upsertUsage(runId: string, usage: RuntimeUsageRecord[]): Promise<void> {
    const prisma = getPrisma();
    for (const entry of usage) {
      await prisma.usageRecord.upsert({
        where: {
          runId_provider_model: { runId, provider: entry.provider, model: entry.model },
        },
        create: {
          runId,
          provider: entry.provider,
          model: entry.model,
          calls: entry.calls,
          promptTokens: entry.promptTokens,
          completionTokens: entry.completionTokens,
          totalTokens: entry.totalTokens,
          costUsd: entry.costUsd,
        },
        update: {
          calls: entry.calls,
          promptTokens: entry.promptTokens,
          completionTokens: entry.completionTokens,
          totalTokens: entry.totalTokens,
          costUsd: entry.costUsd,
        },
      });
    }
  },

  async countByHarnessStatus(harnessId: string, statuses: RunStatus[]): Promise<number> {
    return getPrisma().run.count({ where: { harnessId, status: { in: statuses } } });
  },

  async countForAgent(agentId: string): Promise<number> {
    return getPrisma().run.count({ where: { agentId } });
  },

  /** Harness ids that belong to a set of projects (ownership scoping for lists). */
  async harnessIdsForProjects(projectIds: string[]): Promise<string[]> {
    const rows = await getPrisma().harness.findMany({
      where: { projectId: { in: projectIds } },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  },

  async agentIdsForProjects(projectIds: string[]): Promise<string[]> {
    const rows = await getPrisma().agent.findMany({
      where: { projectId: { in: projectIds } },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  },
};
