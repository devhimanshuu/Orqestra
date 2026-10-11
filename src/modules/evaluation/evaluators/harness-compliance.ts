import { z } from "zod";
import type { EvaluationInput, EvaluationOutcome, ObservedStep } from "../evaluation.types";
import { EvaluatorConfigInvalid, type EvaluatorDefinition } from "./contract";

/**
 * Harness compliance evaluator.
 *
 * Answers "did the harness follow the intended workflow?" using only what the
 * runtime recorded: which nodes executed, in what order, how often, and whether
 * any node the workflow forbids was touched.
 *
 * This evaluates *observable execution behaviour*. It deliberately says nothing
 * about the model's internal reasoning — a run can satisfy every node
 * constraint and still be wrong, and this evaluator will say so by scoring the
 * workflow, not the answer.
 */

export const harnessComplianceConfigSchema = z.strictObject({
  /** Node ids that must have executed. */
  requiredNodes: z.array(z.string().min(1).max(120)).max(100).default([]),
  /** Node ids that must not have been attempted. */
  prohibitedNodes: z.array(z.string().min(1).max(120)).max(100).default([]),
  /** Node types that must appear in the executed set (e.g. "critic"). */
  requiredNodeTypes: z.array(z.string().min(1).max(60)).max(50).default([]),
  /** Per-node cap on attempted executions (bounds loop/retry explosions). */
  maxNodeAttempts: z.record(z.string(), z.number().int().min(1).max(1_000)).default({}),
  /** Require the run itself to have succeeded before compliance counts. */
  requireSucceededRun: z.boolean().default(false),
});

export type HarnessComplianceConfig = z.infer<typeof harnessComplianceConfigSchema>;

export interface NodeExecutionSummary {
  /** Nodes with at least one step, mapped to how many times they were attempted. */
  attempts: Record<string, number>;
  /** Nodes whose last attempt succeeded. */
  succeededNodes: string[];
  /** Nodes that failed. */
  failedNodes: string[];
  /** Nodes skipped by the engine (branch not taken). */
  skippedNodes: string[];
}

export function summarizeNodeExecution(steps: readonly ObservedStep[]): NodeExecutionSummary {
  const attempts: Record<string, number> = {};
  const succeeded = new Set<string>();
  const failed = new Set<string>();
  const skipped = new Set<string>();

  for (const step of steps) {
    attempts[step.nodeId] = (attempts[step.nodeId] ?? 0) + 1;
    if (step.status === "SUCCEEDED") {
      succeeded.add(step.nodeId);
    } else if (step.status === "FAILED") {
      failed.add(step.nodeId);
    } else if (step.status === "SKIPPED") {
      skipped.add(step.nodeId);
    }
  }

  return {
    attempts,
    succeededNodes: [...succeeded].sort(),
    failedNodes: [...failed].sort(),
    skippedNodes: [...skipped].sort(),
  };
}

export const harnessComplianceEvaluator: EvaluatorDefinition<HarnessComplianceConfig> = {
  kind: "harness_compliance",
  label: "Harness compliance",
  description: "Checks which harness nodes executed, and enforces workflow constraints.",
  usesLlm: false,
  configSchema: harnessComplianceConfigSchema,
  configFields: [
    { name: "requiredNodes", label: "Required nodes", type: "string[]", description: "Node ids that must run." },
    { name: "prohibitedNodes", label: "Prohibited nodes", type: "string[]", description: "Node ids that must not run." },
    { name: "requiredNodeTypes", label: "Required node types", type: "string[]", description: "Node types that must appear (e.g. critic)." },
    { name: "maxNodeAttempts", label: "Max attempts per node", type: "json", description: "Map of node id → maximum attempts." },
    { name: "requireSucceededRun", label: "Require a successful run", type: "boolean", default: false },
  ],
  defaultConfig: {
    requiredNodes: [],
    prohibitedNodes: [],
    requiredNodeTypes: [],
    maxNodeAttempts: {},
    requireSucceededRun: false,
  },

  async evaluate(input: EvaluationInput, _context, config): Promise<EvaluationOutcome> {
    for (const [nodeId, max] of Object.entries(config.maxNodeAttempts)) {
      if (max < 1) {
        throw new EvaluatorConfigInvalid(`Node "${nodeId}" has max attempts ${max} — it could never run.`);
      }
    }

    const summary = summarizeNodeExecution(input.run.steps);
    const executedTypes = new Set(input.run.steps.map((step: ObservedStep) => step.nodeType));

    const missingNodes = config.requiredNodes.filter(
      (nodeId) => (summary.attempts[nodeId] ?? 0) === 0,
    );
    const prohibitedExecuted = config.prohibitedNodes.filter(
      (nodeId) => (summary.attempts[nodeId] ?? 0) > 0,
    );
    const missingTypes = config.requiredNodeTypes.filter((type) => !executedTypes.has(type));
    const overAttempts = Object.entries(config.maxNodeAttempts).filter(
      ([nodeId, max]) => (summary.attempts[nodeId] ?? 0) > max,
    );
    const runNotSucceeded =
      config.requireSucceededRun && input.run.status !== "SUCCEEDED";

    const checks =
      config.requiredNodes.length +
      config.prohibitedNodes.length +
      config.requiredNodeTypes.length +
      Object.keys(config.maxNodeAttempts).length +
      (config.requireSucceededRun ? 1 : 0);
    const failed =
      missingNodes.length +
      prohibitedExecuted.length +
      missingTypes.length +
      overAttempts.length +
      (runNotSucceeded ? 1 : 0);
    const satisfied = Math.max(0, checks - failed);
    const score = checks === 0 ? 1 : satisfied / checks;
    const passed = failed === 0;

    const parts: string[] = [
      `${input.run.steps.length} step(s) across ${Object.keys(summary.attempts).length} node(s)`,
    ];
    if (summary.failedNodes.length > 0) {
      parts.push(`failed node(s): ${summary.failedNodes.join(", ")}`);
    }
    if (missingNodes.length > 0) {
      parts.push(`required node(s) never executed: ${missingNodes.join(", ")}`);
    }
    if (prohibitedExecuted.length > 0) {
      parts.push(`prohibited node(s) executed: ${prohibitedExecuted.join(", ")}`);
    }
    if (missingTypes.length > 0) {
      parts.push(`required node type(s) missing: ${missingTypes.join(", ")}`);
    }
    for (const [nodeId, max] of overAttempts) {
      parts.push(`${nodeId} ran ${summary.attempts[nodeId] ?? 0} time(s), above the maximum of ${max}`);
    }
    if (runNotSucceeded) {
      parts.push(`the run itself did not succeed (status ${input.run.status})`);
    }
    if (checks === 0) {
      parts.push("No workflow constraints configured.");
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
        runStatus: input.run.status,
        attempts: summary.attempts,
        failedNodes: summary.failedNodes,
        skippedNodes: summary.skippedNodes,
        missingNodes,
        prohibitedExecuted,
        missingTypes,
        overAttempts: Object.fromEntries(overAttempts),
      },
    };
  },
};
