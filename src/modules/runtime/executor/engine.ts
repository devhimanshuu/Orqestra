/**
 * Execution engine.
 *
 * The engine is a single-writer state machine over a compiled plan:
 *
 *   queued → running → (node …) → completed | failed | cancelled | timeout
 *
 * Design rules that are load-bearing:
 *  - the engine owns state, status, budgets, events and next-node selection;
 *    executors only compute one node's result;
 *  - nothing is persisted here: sinks (`onStepStarted`, `onStepFinished`,
 *    `onStatusChange`, event sinks) let a worker or an inline runner store the
 *    trace without the engine knowing about the database;
 *  - cancellation is observed *between* nodes and inside services (the abort
 *    signal reaches every LLM/tool call), so a cancelled run stops doing work
 *    instead of just being marked cancelled;
 *  - failures are classified once, at the top, and become a terminal status
 *    plus a user-safe error payload.
 */

import type { Logger } from "@/lib/logging/logger";
import type { LLMGateway } from "@/modules/llm/llm.gateway";
import type { ToolRegistry } from "@/modules/tools/tool.registry";
import { HarnessValidationError } from "@/modules/harness/harness.types";
import type { HarnessValidationIssue } from "@/modules/harness/harness.validation";
import {
  CancelledError,
  HarnessNotExecutableError,
  InternalRuntimeError,
  LimitExceededError,
  MaxIterationsError,
  NodeExecutionError,
  RuntimeTimeoutError,
  toRuntimeErrorPayload,
  type RuntimeErrorPayload,
} from "../errors/runtime-error";
import { RuntimeEventEmitter, type RuntimeEventSink } from "../events/event-emitter";
import { LimitTracker } from "../policies/limits";
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "../policies/retry";
import {
  appendStep,
  createExecutionState,
  finishExecutionState,
  PERSISTED_STATUS_BY_EXECUTION_STATUS,
  transitionExecutionState,
  type ExecutionState,
  type ExecutionStatus,
  type ExecutionStep,
  type PersistedRunStatus,
  type RuntimeExecutionLimits,
} from "../state/execution-state";
import { UsageTracker, type UsageEntry, type UsageTotal } from "../usage/tracker";
import { getNodeExecutorRegistry } from "../nodes/registry";
import type { RuntimeAgentContext, NodeExecutionResult } from "../nodes/node-executor";
import { createRuntimeServices } from "../services/runtime-services";
import { ALLOW_ALL_TOOLS, type ToolPermissionPolicy } from "../services/permissions";
import { buildExpressionScope } from "./scope";
import { compileHarness, type CompiledNode, type ExecutionPlan } from "../compiler";

export interface ExecuteHarnessOptions {
  runId: string;
  harnessVersionId: string;
  /** Raw DSL document (validated + compiled here) or an already-compiled plan. */
  definition: unknown;
  input: unknown;
  agent?: RuntimeAgentContext | null;
  limits?: Partial<RuntimeExecutionLimits>;
  gateway: LLMGateway;
  toolRegistry: ToolRegistry;
  permissions?: ToolPermissionPolicy;
  signal?: AbortSignal;
  /** Extra cancellation channel (e.g. a Redis flag set by POST /cancel). */
  shouldCancel?: () => boolean | Promise<boolean>;
  eventSinks?: RuntimeEventSink[];
  retryPolicy?: RetryPolicy;
  llmTimeoutMs?: number;
  toolTimeoutMs?: number;
  logger: Logger;
  now?: () => Date;
  onStepStarted?: (step: ExecutionStep) => void | Promise<void>;
  onStepFinished?: (step: ExecutionStep) => void | Promise<void>;
  /** Fired on every status change (queued→running, …, → terminal). */
  onStatusChange?: (state: ExecutionState) => void | Promise<void>;
}

export interface ExecuteHarnessOutcome {
  runId: string;
  status: Extract<ExecutionStatus, "completed" | "failed" | "cancelled" | "timeout">;
  output: unknown;
  error: RuntimeErrorPayload | null;
  state: ExecutionState;
  usage: UsageTotal;
  usageByModel: UsageEntry[];
  durationMs: number;
  steps: ExecutionStep[];
  plan: ExecutionPlan;
  /** Persisted status enum, so callers never re-derive the mapping. */
  persistedStatus: PersistedRunStatus;
}

/**
 * Applies a validated transition in place.
 *
 * `transitionExecutionState` is functional (guarded, returns a new state); the
 * engine keeps one mutable state object because the per-run services hold a
 * reference to it. Mutating through this helper keeps both properties: illegal
 * moves still throw, and every holder sees the new status.
 */
function setStatus(state: ExecutionState, next: ExecutionStatus): void {
  const transitioned = transitionExecutionState(state, next);
  state.status = transitioned.status;
}

/** Applies a terminal transition in place (status, output, error, completedAt). */
function finish(state: ExecutionState, status: TerminalStatus, options: Parameters<typeof finishExecutionState>[2]): void {
  const finished = finishExecutionState(state, status, options);
  Object.assign(state, finished);
}

type TerminalStatus = Extract<ExecutionStatus, "completed" | "failed" | "cancelled" | "timeout">;

function assertNotCancelled(signal: AbortSignal | undefined, nodeId: string | null): void {
  if (signal?.aborted === true) {
    throw new CancelledError("Run was cancelled", nodeId === null ? {} : { nodeId });
  }
}

/** Runs a validated harness definition to completion. Never throws for run failures. */
export async function executeHarness(options: ExecuteHarnessOptions): Promise<ExecuteHarnessOutcome> {
  const now = options.now ?? ((): Date => new Date());
  const registry = getNodeExecutorRegistry();

  // --- compile -------------------------------------------------------------
  const compiled = compileHarness(options.definition);
  if (!compiled.ok) {
    const issues: HarnessValidationIssue[] = compiled.issues;
    const notExecutable = issues.some(
      (issue) => issue.code === "NODE_NOT_EXECUTABLE" || issue.code === "NODE_CONFIG_INVALID",
    );
    if (notExecutable) {
      throw new HarnessNotExecutableError(
        `Harness version ${options.harnessVersionId} cannot be executed: ${issues
          .map((issue) => issue.message)
          .join("; ")}`,
        { details: { issues } },
      );
    }
    throw new HarnessValidationError(issues);
  }
  const plan = compiled.plan;

  // --- state, events, budgets ---------------------------------------------
  const startedAt = now();
  const harnessId = harnessIdFromDefinition(options.definition) ?? "";
  const state = createExecutionState({
    runId: options.runId,
    harnessId,
    harnessVersionId: options.harnessVersionId,
    agentId: options.agent?.id ?? null,
    agentVersion: options.agent?.version ?? null,
    input: options.input,
    nodeCount: plan.stats.nodeCount,
    edgeCount: plan.stats.edgeCount,
    nodeTypes: [...new Set(plan.nodes.map((node) => node.type))],
    ...(options.limits !== undefined ? { limits: options.limits } : {}),
    startedAt,
  });
  // The plan's definition id is the harness identity; validation guaranteed it.

  const emitter = new RuntimeEventEmitter(
    options.runId,
    options.eventSinks ?? [],
    now,
    options.logger,
  );
  const limits = new LimitTracker(state.metadata.limits, startedAt.getTime(), () => now().getTime());
  const usage = new UsageTracker();

  const currentState = state;
  const persistStatus = async (): Promise<void> => {
    await options.onStatusChange?.(currentState);
  };

  transitionExecutionState(currentState, "running");
  currentState.status = "running";
  currentState.startedAt = startedAt;
  emitter.emit({ type: "RUN_STARTED", entryNode: plan.entryNode });
  await persistStatus();

  const { services } = createRuntimeServices({
    gateway: options.gateway,
    toolRegistry: options.toolRegistry,
    permissions: options.permissions ?? ALLOW_ALL_TOOLS,
    emitter,
    limits,
    usage,
    logger: options.logger,
    signal: options.signal ?? new AbortController().signal,
    now,
    state: currentState,
    agent: options.agent ?? null,
    retryPolicy: options.retryPolicy ?? DEFAULT_RETRY_POLICY,
    ...(options.llmTimeoutMs !== undefined ? { llmTimeoutMs: options.llmTimeoutMs } : {}),
    ...(options.toolTimeoutMs !== undefined ? { toolTimeoutMs: options.toolTimeoutMs } : {}),
  });

  // --- traversal -----------------------------------------------------------
  let cursor: string | null = plan.entryNode;
  let previous: { nodeId: string | null; output: unknown } = { nodeId: null, output: undefined };
  let iteration = 0;
  let finalOutput: unknown = null;
  let termination: TerminalStatus = "completed";
  let failure: RuntimeErrorPayload | null = null;

  try {
    while (cursor !== null) {
      assertNotCancelled(options.signal, cursor);
      if (options.shouldCancel !== undefined && (await options.shouldCancel())) {
        throw new CancelledError("Run cancelled by request");
      }
      limits.assertWithinDeadline();

      const node = plan.compiledNodes[cursor];
      if (node === undefined) {
        throw new InternalRuntimeError(`Execution plan references unknown node "${cursor}"`);
      }

      limits.registerNode(node.id);

      const step: ExecutionStep = {
        nodeId: node.id,
        nodeType: node.type,
        nodeLabel: node.label,
        status: "running",
        startedAt: now(),
        completedAt: null,
        durationMs: null,
        input: previous.output === undefined ? options.input : previous.output,
        output: null,
        error: null,
        metadata: { order: node.order },
      };
      appendStep(currentState, step);
      currentState.currentNodeId = node.id;
      emitter.emit({
        type: "NODE_STARTED",
        nodeId: node.id,
        nodeType: node.type,
        label: node.label,
      });
      await options.onStepStarted?.(step);

      let result: NodeExecutionResult;
      try {
        const executor = registry.get(node.type);
        result = await executor.execute(
          {
            run: {
              id: currentState.runId,
              harnessId: currentState.harnessId,
              harnessVersionId: currentState.harnessVersionId,
              iteration,
            },
            node: {
              id: node.id,
              type: node.type,
              label: node.label,
              ...(node.description !== undefined ? { description: node.description } : {}),
              config: node.config,
            },
            input: previous.output === undefined ? options.input : previous.output,
            outgoing: node.outgoing.map((edge) => ({
              edgeId: edge.id,
              target: edge.target,
              label: edge.label,
            })),
            scope: buildExpressionScope({
              state: currentState,
              previous,
              iteration,
              now: now(),
            }),
            services,
          },
          node.config,
        );
      } catch (error) {
        const payload = toRuntimeErrorPayload(error, node.id);
        step.status = "failed";
        step.completedAt = now();
        step.durationMs = Math.max(0, step.completedAt.getTime() - (step.startedAt?.getTime() ?? 0));
        step.error = payload;
        emitter.emit({ type: "NODE_FAILED", nodeId: node.id, nodeType: node.type, error: payload });
        await options.onStepFinished?.(step);
        throw error;
      }

      // Commit the result: state patch, step record, trace metadata.
      if (result.state !== undefined) {
        currentState.variables = { ...currentState.variables, ...result.state };
      }
      step.status = "succeeded";
      step.output = result.output;
      step.completedAt = now();
      step.durationMs = Math.max(0, step.completedAt.getTime() - (step.startedAt?.getTime() ?? 0));
      step.metadata = {
        ...step.metadata,
        ...(result.metadata ?? {}),
        ...(result.branch !== undefined ? { branch: result.branch } : {}),
        ...(result.warnings !== undefined && result.warnings.length > 0
          ? { warnings: result.warnings }
          : {}),
      };

      if (typeof result.metadata?.["iteration"] === "number") {
        iteration = result.metadata["iteration"];
      }

      emitter.emit({
        type: "NODE_COMPLETED",
        nodeId: node.id,
        nodeType: node.type,
        status: "succeeded",
        durationMs: step.durationMs,
      });

      // Loop narration lives in the engine: executors count iterations, the
      // engine emits the events (it owns the emitter and the sequence numbers).
      if (node.type === "loop") {
        const loopIteration = result.metadata?.["iteration"];
        const maxIterations = result.metadata?.["maxIterations"];
        if (typeof loopIteration === "number" && typeof maxIterations === "number") {
          if (loopIteration === 1 && result.branch === "body") {
            emitter.emit({ type: "LOOP_STARTED", nodeId: node.id, maxIterations });
          }
          if (result.branch === "body") {
            emitter.emit({
              type: "LOOP_ITERATION",
              nodeId: node.id,
              iteration: loopIteration,
              maxIterations,
            });
          }
        }
      }

      await options.onStepFinished?.(step);

      previous = { nodeId: node.id, output: result.output };
      currentState.variables["lastNodeId"] = node.id;
      currentState.variables["lastOutput"] = result.output;

      // --- next node ---------------------------------------------------------
      const next = selectNextNode(plan, node, result);
      if (next === null) {
        if (node.type === "end") {
          finalOutput = result.output;
          setStatus(currentState, "completed");
          finish(currentState, "completed", { output: result.output, at: now() });
          emitter.emit({
            type: "RUN_COMPLETED",
            status: "completed",
            durationMs: (currentState.completedAt?.getTime() ?? startedAt.getTime()) - startedAt.getTime(),
          });
          await persistStatus();
          termination = "completed";
          cursor = null;
          break;
        }
        throw new NodeExecutionError(
          `Node "${node.label}" has no outgoing edge on branch ${describeBranch(result.branch)}`,
          { nodeId: node.id },
        );
      }
      cursor = next;
    }
  } catch (error) {
    const { status, payload } = classifyTermination(error, currentState.currentNodeId);
    termination = status;
    failure = payload;

    // A step may already be marked failed; if the error happened between nodes
    // (budget, cancellation), mark the current step instead.
    const runningStep = currentState.history.find((step) => step.status === "running");
    if (runningStep !== undefined) {
      runningStep.status = status === "cancelled" ? "skipped" : "failed";
      runningStep.completedAt = now();
      runningStep.durationMs = Math.max(
        0,
        runningStep.completedAt.getTime() - (runningStep.startedAt?.getTime() ?? 0),
      );
      runningStep.error = payload;
    }

    const at = now();
    finish(currentState, status, {
      error: payload,
      ...(currentState.output !== null ? { output: currentState.output } : {}),
      at,
    });

    if (status === "cancelled") {
      emitter.emit({ type: "RUN_CANCELLED", reason: payload.message });
    } else if (status === "timeout") {
      emitter.emit({ type: "RUN_TIMED_OUT", error: payload });
    } else {
      emitter.emit({ type: "RUN_FAILED", status: "failed", error: payload });
    }
    await persistStatus();
  }

  const completedAt = currentState.completedAt ?? now();
  const outcome: ExecuteHarnessOutcome = {
    runId: options.runId,
    status: termination,
    output: finalOutput === null ? currentState.output : finalOutput,
    error: failure,
    state: currentState,
    usage: usage.total(),
    usageByModel: usage.byModel(),
    durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
    steps: currentState.history,
    plan,
    persistedStatus: PERSISTED_STATUS_BY_EXECUTION_STATUS[termination],
  };
  return outcome;
}

/** Chooses the next node from the executor result (branch, override, or end). */
function selectNextNode(
  plan: ExecutionPlan,
  node: CompiledNode,
  result: NodeExecutionResult,
): string | null {
  if (result.nextNodeId !== undefined) {
    if (plan.compiledNodes[result.nextNodeId] === undefined) {
      throw new InternalRuntimeError(
        `Node "${node.label}" routed to unknown node "${result.nextNodeId}"`,
      );
    }
    return result.nextNodeId;
  }

  const handle = result.branch ?? "";
  const edges = node.branches[handle];
  if (edges === undefined || edges.length === 0) {
    if (result.branch !== undefined && node.outgoing.length > 0) {
      throw new NodeExecutionError(
        `Node "${node.label}" selected branch "${result.branch}" but no edge is wired to it`,
        { nodeId: node.id },
      );
    }
    return null;
  }
  return edges[0]?.target ?? null;
}

function describeBranch(branch: string | undefined): string {
  return branch === undefined || branch === "" ? "(default)" : `"${branch}"`;
}

/** Maps a thrown error onto a terminal status + user-safe payload. */
function classifyTermination(
  error: unknown,
  nodeId: string | null,
): {
  status: Extract<TerminalStatus, "failed" | "cancelled" | "timeout">;
  payload: RuntimeErrorPayload;
} {
  const payload = toRuntimeErrorPayload(error, nodeId ?? undefined);
  if (error instanceof CancelledError) {
    return { status: "cancelled", payload };
  }
  if (error instanceof RuntimeTimeoutError) {
    return { status: "timeout", payload };
  }
  if (error instanceof MaxIterationsError || error instanceof LimitExceededError) {
    return { status: "failed", payload };
  }
  return { status: "failed", payload };
}

/** Reads `definition.id` without trusting it (compile already validated it). */
function harnessIdFromDefinition(definition: unknown): string | null {
  if (typeof definition !== "object" || definition === null) {
    return null;
  }
  const id = (definition as Record<string, unknown>)["id"];
  return typeof id === "string" && id !== "" ? id : null;
}
