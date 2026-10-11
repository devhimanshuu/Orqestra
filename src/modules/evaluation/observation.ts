/**
 * Run observation projection.
 *
 * Evaluators must not receive Prisma rows or a live runtime object: they get a
 * plain, detached summary of what the runtime recorded. Building it in one place
 * means every evaluator sees the same shape, and no evaluator can reach a
 * database handle by accident.
 *
 * `steps` are ordered by their persisted index — the *actual* execution order,
 * never the harness's visual node order.
 */

import type { Run, RunStep, RuntimeUsageRecord } from "@/modules/runtime/run.types";
import type { ObservedStep, RunObservation } from "./evaluation.types";

/** Reads a string field from a step's metadata bag. */
function metadataString(step: RunStep, key: string): string | null {
  const value = step.metadata?.[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function toObservedStep(step: RunStep): ObservedStep {
  return {
    index: step.index,
    nodeId: step.nodeId,
    nodeType: step.nodeType,
    nodeLabel: step.nodeLabel,
    status: step.status,
    durationMs: step.durationMs,
    iteration: step.iteration,
    // Only tool nodes carry a tool id; a `model` step that happens to have a
    // "toolId" key in metadata is not a tool invocation.
    toolId: step.nodeType === "tool" ? metadataString(step, "toolId") : null,
    toolInput: step.nodeType === "tool" ? step.input : null,
    input: step.input,
    output: step.output,
    error: step.error === null ? null : { code: step.error.code, message: step.error.message },
  };
}

export interface ObservationSource {
  run: Run;
  steps: readonly RunStep[];
  usage: readonly RuntimeUsageRecord[];
  usageTotal: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsd: number | null;
    unknownCost: boolean;
  };
}

export function toRunObservation(source: ObservationSource): RunObservation {
  const steps = [...source.steps].sort((a, b) => a.index - b.index).map(toObservedStep);
  const retryOfRunId = source.run.retryOfRunId;

  return {
    runId: source.run.id,
    status: source.run.status,
    input: source.run.input,
    output: source.run.output,
    error:
      source.run.error === null
        ? null
        : {
            code: source.run.error.code,
            message: source.run.error.message,
            ...(source.run.error.retryable !== undefined
              ? { retryable: source.run.error.retryable }
              : {}),
          },
    attempt: source.run.attempt,
    retryOfRunId,
    startedAt: source.run.startedAt,
    completedAt: source.run.completedAt,
    latencyMs: source.run.latencyMs,
    usage: source.usage.map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      calls: entry.calls,
      promptTokens: entry.promptTokens,
      completionTokens: entry.completionTokens,
      totalTokens: entry.totalTokens,
      costUsd: entry.costUsd,
    })),
    usageTotal: {
      calls: source.usageTotal.calls,
      totalTokens: source.usageTotal.totalTokens,
      costUsd: source.usageTotal.costUsd,
      unknownCost: source.usageTotal.unknownCost,
    },
    metadata: source.run.metadata,
    steps,
  };
}
