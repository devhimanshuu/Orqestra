/**
 * Execution limits.
 *
 * Every run has budgets: wall-clock, node visits, LLM calls, tool calls,
 * loop iterations, and optionally cost. The tracker counts as the run proceeds
 * and throws a typed error the moment a budget is exhausted, which the engine
 * turns into a `timeout`/`limit` termination — never an unbounded loop.
 */

import { LimitExceededError, MaxIterationsError, RuntimeTimeoutError } from "../errors/runtime-error";
import type { RuntimeExecutionLimits } from "../state/execution-state";

export interface LimitSnapshot {
  nodes: number;
  llmCalls: number;
  toolCalls: number;
  costUsd: number;
  iterationsByLoop: Record<string, number>;
  elapsedMs: number;
}

export class LimitTracker {
  private nodes = 0;
  private llmCalls = 0;
  private toolCalls = 0;
  private costUsd = 0;
  private readonly iterations = new Map<string, number>();

  constructor(
    private readonly limits: RuntimeExecutionLimits,
    private readonly startedAtMs: number,
    private readonly nowMs: () => number,
  ) {}

  /** Wall-clock guard, checked between nodes and before every external call. */
  assertWithinDeadline(): void {
    const elapsed = this.nowMs() - this.startedAtMs;
    if (elapsed > this.limits.maxDurationMs) {
      throw new RuntimeTimeoutError(
        `Run exceeded its time limit of ${Math.round(this.limits.maxDurationMs / 1000)}s`,
        { retryable: false, details: { elapsedMs: elapsed } },
      );
    }
  }

  registerNode(nodeId: string): void {
    this.nodes += 1;
    if (this.nodes > this.limits.maxNodes) {
      throw new LimitExceededError(
        `Run exceeded the maximum of ${this.limits.maxNodes} node executions`,
        { details: { nodeId, used: this.nodes, max: this.limits.maxNodes, limit: "maxNodes" } },
      );
    }
  }

  registerLlmCall(): void {
    this.llmCalls += 1;
    if (this.llmCalls > this.limits.maxLlmCalls) {
      throw new LimitExceededError(
        `Run exceeded the maximum of ${this.limits.maxLlmCalls} LLM calls`,
        { details: { used: this.llmCalls, max: this.limits.maxLlmCalls, limit: "maxLlmCalls" } },
      );
    }
  }

  registerToolCall(): void {
    this.toolCalls += 1;
    if (this.toolCalls > this.limits.maxToolCalls) {
      throw new LimitExceededError(
        `Run exceeded the maximum of ${this.limits.maxToolCalls} tool calls`,
        { details: { used: this.toolCalls, max: this.limits.maxToolCalls, limit: "maxToolCalls" } },
      );
    }
  }

  /**
   * Records a pass through a loop node. `maxIterations` on the node is a hard
   * per-loop ceiling; the run-level budget applies as well, whichever is
   * reached first.
   */
  registerIteration(loopNodeId: string, nodeMaxIterations: number): number {
    const iteration = (this.iterations.get(loopNodeId) ?? 0) + 1;
    this.iterations.set(loopNodeId, iteration);
    if (iteration > nodeMaxIterations) {
      throw new MaxIterationsError(
        `Loop "${loopNodeId}" exceeded its maximum of ${nodeMaxIterations} iterations`,
        { nodeId: loopNodeId, details: { iteration, maxIterations: nodeMaxIterations } },
      );
    }
    if (iteration > this.limits.maxIterations) {
      throw new MaxIterationsError(
        `Loop "${loopNodeId}" exceeded the run limit of ${this.limits.maxIterations} iterations`,
        { nodeId: loopNodeId, details: { iteration, maxIterations: this.limits.maxIterations } },
      );
    }
    return iteration;
  }

  registerCost(costUsd: number | null): void {
    if (costUsd === null) {
      return;
    }
    this.costUsd += costUsd;
    const max = this.limits.maxCostUsd;
    if (max !== null && this.costUsd > max) {
      throw new LimitExceededError(`Run exceeded its cost limit of $${max.toFixed(4)}`, {
        details: { used: this.costUsd, max, limit: "maxCostUsd" },
      });
    }
  }

  iterationOf(loopNodeId: string): number {
    return this.iterations.get(loopNodeId) ?? 0;
  }

  resetIterations(loopNodeId: string): void {
    this.iterations.delete(loopNodeId);
  }

  snapshot(): LimitSnapshot {
    return {
      nodes: this.nodes,
      llmCalls: this.llmCalls,
      toolCalls: this.toolCalls,
      costUsd: this.costUsd,
      iterationsByLoop: Object.fromEntries(this.iterations),
      elapsedMs: this.nowMs() - this.startedAtMs,
    };
  }
}
