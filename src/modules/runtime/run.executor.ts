/**
 * Run executor — the bridge between the pure runtime and durable state.
 *
 *   load run → claim it → load harness version + agent version → snapshot pins
 *     → executeHarness (events streamed live, steps persisted as they finish)
 *     → persist output/usage/error → release
 *
 * Both the BullMQ worker and the inline dispatcher call exactly this function,
 * so "how a run executes" has one implementation and one code path.
 *
 * Persistence discipline:
 *  - steps are inserted at start and completed at finish (a crash leaves an
 *    honest RUNNING row instead of a silent hole);
 *  - run-level events are appended in one batch at the end (the live stream is
 *    SSE/Redis, not a database round-trip per event);
 *  - the run row is written on every status change and finally with output,
 *    usage, cost and latency.
 */

import { logger } from "@/lib/logging/logger";
import { getEnv } from "@/config/env";
import { getLLMGateway } from "@/modules/llm/llm.gateway";
import { getToolRegistry } from "@/modules/tools";
import { agentRepository } from "@/modules/agents/agent.repository";
import { harnessRepository } from "@/modules/harness/harness.repository";
import { executeHarness, type ExecuteHarnessOutcome } from "./executor/engine";
import { RUNTIME_ENGINE_VERSION } from "./runtime";
import { allowlistFromCapabilities } from "./services/permissions";
import { DEFAULT_RUNTIME_LIMITS } from "./state/execution-state";
import type { RuntimeAgentContext } from "./nodes/node-executor";
import { publishRunEventLocally, publishRunEventToRedis, isRunCancellationRequested, clearRunCancellation } from "./events/bus";
import type { RuntimeEvent } from "./events/events";
import { runRepository } from "./run.repository";
import type { Run, RunMetadata, RuntimeUsageRecord } from "./run.types";
import { RunNotFoundError } from "./run.types";
import { toRuntimeErrorPayload } from "./errors/runtime-error";

const executorLogger = logger.child({ module: "runtime.executor" });

function limitsFromEnv(): typeof DEFAULT_RUNTIME_LIMITS {
  const env = getEnv();
  return {
    ...DEFAULT_RUNTIME_LIMITS,
    maxDurationMs: env.RUNTIME_MAX_DURATION_MS,
    maxNodes: env.RUNTIME_MAX_NODES,
    maxIterations: env.RUNTIME_MAX_ITERATIONS,
    maxLlmCalls: env.RUNTIME_MAX_LLM_CALLS,
    maxToolCalls: env.RUNTIME_MAX_TOOL_CALLS,
  };
}

function modelParts(ref: string | null): { model: string | null; provider: string | null } {
  if (ref === null) {
    return { model: null, provider: null };
  }
  const separator = ref.indexOf(":");
  if (separator <= 0) {
    return { model: ref, provider: null };
  }
  return { provider: ref.slice(0, separator), model: ref.slice(separator + 1) };
}

export interface ExecuteRunResult {
  runId: string;
  status: Run["status"];
  skipped: boolean;
}

/**
 * How a run reached this executor. Recorded on the run's metadata so a stored
 * run says whether a worker picked it up from the queue or the app ran it
 * in-process; "unknown" only happens for direct calls (scripts).
 */
export type ExecutionTransport = RunMetadata["executionMode"];

export interface ExecuteRunOptions {
  transport?: ExecutionTransport;
}

/**
 * Executes a queued run. Safe to call twice: the second caller sees the run is
 * already claimed and returns without doing anything.
 */
export async function executeRun(
  runId: string,
  options: ExecuteRunOptions = {},
): Promise<ExecuteRunResult> {
  const run = await runRepository.findById(runId);
  if (run === null) {
    throw new RunNotFoundError(runId);
  }

  if (run.status !== "QUEUED") {
    executorLogger.info("run already claimed — skipping", { runId, status: run.status });
    return { runId, status: run.status, skipped: true };
  }

  const claimed = await runRepository.claimForExecution(runId, new Date());
  if (claimed === null) {
    executorLogger.info("run claim lost — skipping", { runId });
    return { runId, status: run.status, skipped: true };
  }

  const harnessVersion = await harnessRepository.findVersionById(claimed.harnessVersionId);
  if (harnessVersion === null) {
    await failRun(runId, "HARNESS_NOT_EXECUTABLE", "The harness version this run pins no longer exists");
    return { runId, status: "FAILED", skipped: false };
  }

  const agentVersion =
    claimed.agentId === null ? null : await agentRepository.findLatestVersion(claimed.agentId);
  const agentContext: RuntimeAgentContext | null =
    claimed.agentId === null
      ? null
      : {
          id: claimed.agentId,
          version: agentVersion?.version ?? claimed.agentVersion ?? null,
          instructions: agentVersion?.instructions ?? null,
          model: agentVersion?.modelConfig.model ?? null,
          capabilities: agentVersion?.capabilities ?? [],
        };

  // Limits are taken from the run's own metadata snapshot when present (so a
  // retry of an old run keeps its budget), otherwise from the environment.
  const limits = claimed.metadata?.limits ?? limitsFromEnv();
  const permissionPolicy = allowlistFromCapabilities(agentContext?.capabilities ?? []);

  const events: RuntimeEvent[] = [];
  const traceByStep = new Map<string, RuntimeEvent[]>();
  const stepRowIds = new Map<string, string>();
  const pendingTraces: Array<{ stepRowId: string; events: RuntimeEvent[] }> = [];
  let activeNodeId: string | null = null;
  // The engine executes nodes strictly sequentially, so the executor can number
  // steps itself instead of paying a `max(index)` query per node.
  let stepIndex = 0;

  const controller = new AbortController();
  const metadata: RunMetadata = {
    engineVersion: RUNTIME_ENGINE_VERSION,
    harnessContentHash: harnessVersion.contentHash,
    harnessVersion: harnessVersion.version,
    nodeCount: harnessVersion.definition.nodes.length,
    edgeCount: harnessVersion.definition.edges.length,
    nodeTypes: [...new Set(harnessVersion.definition.nodes.map((node) => node.type))],
    ...modelParts(agentContext?.model ?? null),
    limits,
    allowedTools: permissionPolicy.allowed,
    executionMode: options.transport ?? "unknown",
    agentName: null,
  };

  executorLogger.info("run started", {
    runId,
    harnessId: claimed.harnessId,
    harnessVersion: harnessVersion.version,
    agentId: claimed.agentId,
  });

  let outcome: ExecuteHarnessOutcome;
  try {
    outcome = await executeHarness({
      runId,
      harnessVersionId: harnessVersion.id,
      definition: harnessVersion.definition,
      input: claimed.input,
      agent: agentContext,
      limits,
      gateway: getLLMGateway(),
      toolRegistry: getToolRegistry(),
      permissions: permissionPolicy,
      signal: controller.signal,
      shouldCancel: () => isRunCancellationRequested(runId),
      logger: executorLogger,
      eventSinks: [
        (event) => {
          events.push(event);
          publishRunEventLocally(runId, event);
          void publishRunEventToRedis(runId, event);
          if (event.type === "NODE_STARTED") {
            activeNodeId = event.nodeId;
          }
          if (
            event.type === "NODE_STARTED" ||
            event.type === "NODE_COMPLETED" ||
            event.type === "NODE_FAILED"
          ) {
            const bucket = traceByStep.get(event.nodeId) ?? [];
            bucket.push(event);
            traceByStep.set(event.nodeId, bucket);
          } else {
            // Run-level events are attached to the step in flight, so the trace
            // document reads chronologically.
            const key = activeNodeId ?? "__run__";
            const bucket = traceByStep.get(key) ?? [];
            bucket.push(event);
            traceByStep.set(key, bucket);
          }
        },
      ],
      onStepStarted: async (step) => {
        const rowId = await runRepository.insertStep(runId, stepIndex, step);
        stepIndex += 1;
        stepRowIds.set(step.nodeId, rowId);
      },
      onStepFinished: async (step) => {
        const rowId = stepRowIds.get(step.nodeId);
        if (rowId === undefined) {
          return;
        }
        await runRepository.completeStep(rowId, step);
        pendingTraces.push({ stepRowId: rowId, events: traceByStep.get(step.nodeId) ?? [] });
      },
      onStatusChange: async (state) => {
        await runRepository.updateStatus(runId, {
          status: outcomeStatus(state.status),
          startedAt: state.startedAt,
          completedAt: state.completedAt,
        });
      },
    });
  } catch (error) {
    // Compile/validation failures throw before execution: they are still runs,
    // so they must be persisted as failures with a user-safe reason.
    const payload = toRuntimeErrorPayload(error);
    await runRepository.saveTraces(pendingTraces);
    await runRepository.appendEvents(runId, events);
    await failRun(runId, payload.code, payload.message, payload.retryable);
    executorLogger.error("run failed before execution", { runId, code: payload.code });
    return { runId, status: "FAILED", skipped: false };
  }

  const usageRecords: RuntimeUsageRecord[] = outcome.usageByModel.map((entry) => ({
    provider: entry.provider,
    model: entry.model,
    calls: entry.calls,
    promptTokens: entry.promptTokens,
    completionTokens: entry.completionTokens,
    totalTokens: entry.totalTokens,
    costUsd: entry.costUsd,
  }));

  await runRepository.saveTraces(pendingTraces);
  await runRepository.appendEvents(runId, events);
  await runRepository.upsertUsage(runId, usageRecords);
  await runRepository.updateStatus(runId, {
    status: outcome.persistedStatus,
    startedAt: outcome.state.startedAt,
    completedAt: outcome.state.completedAt,
    output: outcome.output,
    error: outcome.error,
    tokenUsage: {
      promptTokens: outcome.usage.promptTokens,
      completionTokens: outcome.usage.completionTokens,
      totalTokens: outcome.usage.totalTokens,
    },
    cost: outcome.usage.costUsd,
    latencyMs: outcome.durationMs,
    metadata: {
      ...metadata,
      status: outcome.status,
      steps: outcome.steps.length,
      usageByModel: usageRecords.map((entry) => ({ provider: entry.provider, model: entry.model })),
      errorCode: outcome.error?.code ?? null,
      contentHash: outcome.plan.contentHash,
    },
  });

  await clearRunCancellation(runId);

  executorLogger.info("run finished", {
    runId,
    status: outcome.status,
    durationMs: outcome.durationMs,
    steps: outcome.steps.length,
    totalTokens: outcome.usage.totalTokens,
    costUsd: outcome.usage.costUsd,
  });

  return { runId, status: outcome.persistedStatus as Run["status"], skipped: false };
}

function outcomeStatus(status: string): Run["status"] {
  switch (status) {
    case "queued":
      return "QUEUED";
    case "running":
    case "waiting":
    case "paused":
      return "RUNNING";
    case "completed":
      return "SUCCEEDED";
    case "cancelled":
      return "CANCELLED";
    case "timeout":
      return "TIMED_OUT";
    default:
      return "FAILED";
  }
}

async function failRun(
  runId: string,
  code: string,
  message: string,
  retryable = false,
): Promise<void> {
  await runRepository.updateStatus(runId, {
    status: code === "TIMEOUT" ? "TIMED_OUT" : code === "CANCELLED" ? "CANCELLED" : "FAILED",
    completedAt: new Date(),
    error: {
      code: code as ReturnType<typeof toRuntimeErrorPayload>["code"],
      message,
      retryable,
    },
  });
}


