import type { HarnessDefinition, HarnessNodeType } from "@/modules/harness/harness.schema";
import type { LLMGateway } from "@/modules/llm/llm.gateway";
import type { ToolRegistry } from "@/modules/tools/tool.registry";
import type { Logger } from "@/lib/logging/logger";

/**
 * Runtime boundary contract (Phase 0 = types only).
 *
 * Pipeline this file anticipates:
 *   Harness Definition → Validator → Compiler → Execution Plan → Runtime
 *     → Node Executor → Tool / Model / Memory
 *
 * The Phase 2 runtime implements against these interfaces; nothing here
 * depends on Next.js, React, or any route handler.
 */

/** Everything a run needs to execute — injected, never imported ad hoc. */
export interface ExecutionContext {
  runId: string;
  harnessVersionId: string;
  definition: HarnessDefinition;
  input: unknown;
  /** Process-wide gateway/registry injected so tests can substitute fakes. */
  services: {
    llm: LLMGateway;
    tools: ToolRegistry;
  };
  logger: Logger;
  signal?: AbortSignal;
  /** Injectable clock — determinism in tests. */
  now: () => Date;
}

export type ExecutionStatus =
  "idle" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

export interface ExecutionState {
  status: ExecutionStatus;
  /** Node currently being executed (null between nodes). */
  currentNodeId: string | null;
  /** Shared state flowing through the graph (planner output, scores, …). */
  variables: Record<string, unknown>;
  steps: NodeExecution[];
  /** Current pass for loop nodes. */
  iteration: number;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface RuntimeError {
  code: string;
  message: string;
  nodeId?: string;
}

export interface ExecutionResult {
  runId: string;
  status: Exclude<ExecutionStatus, "idle" | "running">;
  output: unknown;
  error: RuntimeError | null;
  steps: NodeExecution[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cost: number | null;
  };
  latencyMs: number;
}

export interface NodeExecution {
  nodeId: string;
  nodeType: HarnessNodeType;
  nodeLabel: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  startedAt: Date | null;
  completedAt: Date | null;
  durationMs: number | null;
  input: unknown;
  output: unknown;
  error: RuntimeError | null;
}

/** Structured runtime events — persisted as Trace documents, streamed to the Run Lab UI. */
export type RuntimeEvent =
  | { type: "run.started"; seq: number; at: string; harnessVersionId: string }
  | { type: "run.completed"; seq: number; at: string; output: unknown }
  | { type: "run.failed"; seq: number; at: string; error: RuntimeError }
  | { type: "node.started"; seq: number; at: string; nodeId: string; nodeType: HarnessNodeType }
  | { type: "node.completed"; seq: number; at: string; nodeId: string; durationMs: number }
  | { type: "node.failed"; seq: number; at: string; nodeId: string; error: RuntimeError }
  | {
      type: "llm.request";
      seq: number;
      at: string;
      nodeId: string;
      provider: string;
      model: string;
    }
  | {
      type: "llm.response";
      seq: number;
      at: string;
      nodeId: string;
      provider: string;
      model: string;
      usage: { promptTokens: number; completionTokens: number; totalTokens: number };
      latencyMs: number;
    }
  | { type: "tool.started"; seq: number; at: string; nodeId: string; toolId: string }
  | {
      type: "tool.completed";
      seq: number;
      at: string;
      nodeId: string;
      toolId: string;
      durationMs: number;
    }
  | {
      type: "tool.failed";
      seq: number;
      at: string;
      nodeId: string;
      toolId: string;
      error: RuntimeError;
    }
  | { type: "loop.iteration"; seq: number; at: string; nodeId: string; iteration: number }
  | {
      type: "human_approval.requested";
      seq: number;
      at: string;
      nodeId: string;
      timeoutMs: number | null;
    };

/** Implemented by Phase 2 node executors (one per HarnessNodeType). */
export interface NodeExecutor {
  readonly type: HarnessNodeType;
  execute(
    node: { id: string; type: HarnessNodeType; label: string },
    context: ExecutionContext,
    state: ExecutionState,
  ): Promise<NodeExecution>;
}
