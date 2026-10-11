import { z } from "zod";
import type { EvaluationInput, EvaluationOutcome, ObservedStep } from "../evaluation.types";
import { EvaluatorConfigInvalid, type EvaluatorDefinition } from "./contract";

/**
 * Tool usage evaluator.
 *
 * Answers "did the agent use the right tool?" from the *observable* record:
 * the tool steps the runtime persisted. It never infers intent from the model's
 * text, and it never claims a tool was used when the runtime has no step for it.
 *
 * Tool ids counts are invocation counts (a retried tool call appears twice),
 * which is why min/max constraints are per-tool spans rather than booleans.
 */

export const toolUsageConfigSchema = z.strictObject({
  /** Tool ids that must be invoked at least once. */
  required: z.array(z.string().min(1).max(120)).max(50).default([]),
  /** Tool ids that must never be invoked. */
  prohibited: z.array(z.string().min(1).max(120)).max(50).default([]),
  /** Minimum invocation count per tool id. */
  minCalls: z.record(z.string(), z.number().int().min(0).max(1_000)).default({}),
  /** Maximum invocation count per tool id. */
  maxCalls: z.record(z.string(), z.number().int().min(0).max(1_000)).default({}),
});

export type ToolUsageConfig = z.infer<typeof toolUsageConfigSchema>;

/** Tool invocations observed in a run, in execution order. */
export function observedToolCalls(steps: readonly ObservedStep[]): Array<{ toolId: string; step: ObservedStep }> {
  return steps
    .filter((step) => step.nodeType === "tool" && step.toolId !== null && step.toolId !== "")
    .map((step) => ({ toolId: step.toolId as string, step }));
}

export function toolCounts(steps: readonly ObservedStep[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const call of observedToolCalls(steps)) {
    counts[call.toolId] = (counts[call.toolId] ?? 0) + 1;
  }
  return counts;
}

export const toolUsageEvaluator: EvaluatorDefinition<ToolUsageConfig> = {
  kind: "tool_usage",
  label: "Tool usage",
  description: "Checks which tools were called, and enforces per-tool invocation bounds.",
  usesLlm: false,
  configSchema: toolUsageConfigSchema,
  configFields: [
    { name: "required", label: "Required tools", type: "string[]", description: "Tool ids that must be called." },
    { name: "prohibited", label: "Prohibited tools", type: "string[]", description: "Tool ids that must not be called." },
    { name: "minCalls", label: "Minimum calls", type: "json", description: "Map of tool id → minimum invocation count." },
    { name: "maxCalls", label: "Maximum calls", type: "json", description: "Map of tool id → maximum invocation count." },
  ],
  defaultConfig: { required: [], prohibited: [], minCalls: {}, maxCalls: {} },

  async evaluate(input: EvaluationInput, _context, config): Promise<EvaluationOutcome> {
    // A min above the matching max can never be satisfied — that is a broken
    // configuration, not a failed agent.
    for (const [toolId, min] of Object.entries(config.minCalls)) {
      const max = config.maxCalls[toolId];
      if (max !== undefined && min > max) {
        throw new EvaluatorConfigInvalid(
          `Tool "${toolId}" has minCalls ${min} greater than maxCalls ${max} — no run can satisfy this.`,
        );
      }
    }

    const counts = toolCounts(input.run.steps);
    const calledTools = Object.keys(counts).sort();

    const missing = config.required.filter((toolId) => (counts[toolId] ?? 0) === 0);
    const prohibitedCalled = config.prohibited.filter((toolId) => (counts[toolId] ?? 0) > 0);
    const belowMinimum = Object.entries(config.minCalls).filter(
      ([toolId, min]) => (counts[toolId] ?? 0) < min,
    );
    const aboveMaximum = Object.entries(config.maxCalls).filter(
      ([toolId, max]) => (counts[toolId] ?? 0) > max,
    );

    const checks =
      config.required.length +
      config.prohibited.length +
      Object.keys(config.minCalls).length +
      Object.keys(config.maxCalls).length;
    const failed =
      missing.length + prohibitedCalled.length + belowMinimum.length + aboveMaximum.length;
    const satisfied = Math.max(0, checks - failed);
    const score = checks === 0 ? 1 : satisfied / checks;
    const passed = failed === 0;

    const parts: string[] = [];
    if (calledTools.length === 0) {
      parts.push("No tool calls were recorded for this run");
    } else {
      parts.push(
        `tools called: ${calledTools.map((toolId) => `${toolId}×${counts[toolId] ?? 0}`).join(", ")}`,
      );
    }
    if (missing.length > 0) {
      parts.push(`missing required tool(s): ${missing.join(", ")}`);
    }
    if (prohibitedCalled.length > 0) {
      parts.push(`prohibited tool(s) called: ${prohibitedCalled.join(", ")}`);
    }
    for (const [toolId, min] of belowMinimum) {
      parts.push(`${toolId} called ${counts[toolId] ?? 0} time(s), below the minimum of ${min}`);
    }
    for (const [toolId, max] of aboveMaximum) {
      parts.push(`${toolId} called ${counts[toolId] ?? 0} time(s), above the maximum of ${max}`);
    }
    if (checks === 0) {
      parts.push("No tool constraints configured.");
    }

    return {
      status: "COMPLETED",
      score,
      maxScore: 1,
      passed,
      explanation: `${parts.join(" · ")}.`,
      evidence: {
        checks,
        satisfied,
        calledTools: counts,
        missing,
        prohibitedCalled,
        belowMinimum: Object.fromEntries(belowMinimum),
        aboveMaximum: Object.fromEntries(aboveMaximum),
      },
    };
  },
};
