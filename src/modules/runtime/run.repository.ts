import type { Prisma } from "@/generated/prisma/client";
import { getPrisma } from "@/lib/db/prisma";
import type { RuntimeError } from "./execution.types";
import type { Run, RunStatus, RunStep, RunStepStatus, TokenUsage, RunWithSteps } from "./run.types";

/**
 * Run persistence. Rows are append-heavy and read by the observability UI,
 * so ordering (index, createdAt) is always explicit.
 */

function toRuntimeError(value: Prisma.JsonValue | null): RuntimeError | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate["code"] !== "string" || typeof candidate["message"] !== "string") {
    return null;
  }
  return {
    code: candidate["code"],
    message: candidate["message"],
    ...(typeof candidate["nodeId"] === "string" ? { nodeId: candidate["nodeId"] } : {}),
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

function toRun(row: {
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
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}): Run {
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
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    durationMs: row.durationMs,
    createdAt: row.createdAt,
  };
}

export interface CreateRunRowInput {
  harnessId: string;
  harnessVersionId: string;
  input: unknown;
  agentId?: string;
  agentVersion?: number;
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
        input: input.input as Prisma.InputJsonValue,
      },
    });
    return toRun(row);
  },

  async findById(runId: string): Promise<Run | null> {
    const row = await getPrisma().run.findUnique({ where: { id: runId } });
    return row ? toRun(row) : null;
  },

  async findByIdWithSteps(runId: string): Promise<RunWithSteps | null> {
    const row = await getPrisma().run.findUnique({
      where: { id: runId },
      include: { steps: { orderBy: { index: "asc" } } },
    });
    if (row === null) {
      return null;
    }
    return { ...toRun(row), steps: row.steps.map(toRunStep) };
  },

  async listByHarness(harnessId: string, limit = 20): Promise<RunWithSteps[]> {
    const rows = await getPrisma().run.findMany({
      where: { harnessId },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { steps: { orderBy: { index: "asc" } } },
    });
    return rows.map((row) => ({ ...toRun(row), steps: row.steps.map(toRunStep) }));
  },

  async saveTrace(runStepId: string, events: unknown): Promise<void> {
    await getPrisma().trace.create({
      data: { runStepId, events: events as Prisma.InputJsonValue },
    });
  },
};
