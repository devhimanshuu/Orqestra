/**
 * Expression scope builder.
 *
 * Turns execution state into the flat data view that `{{ … }}` templates and
 * condition expressions read. Node outputs are addressable three ways so a
 * harness author never has to guess:
 *
 *   {{ planner.plan }}         node id (as authored in the builder)
 *   {{ steps.planner.output }} explicit form
 *   {{ previous.output }}      whatever ran immediately before
 *
 * Label slugs are registered as aliases of their node id ("Tool Call" →
 * `tool_call`) because labels are what the builder shows; ids stay canonical.
 */

import { toReferenceKey } from "../nodes/node-executor";
import type { ExpressionScope } from "../context/expression";
import type { ExecutionState, ExecutionStep } from "../state/execution-state";

export interface BuildScopeInput {
  state: ExecutionState;
  /** Node that produced the incoming value (null at the start node). */
  previous: { nodeId: string | null; output: unknown };
  /** Current loop iteration (0 outside any loop). */
  iteration: number;
  now: Date;
}

export function buildExpressionScope(input: BuildScopeInput): ExpressionScope {
  const steps: ExpressionScope["steps"] = {};

  for (const step of input.state.history) {
    if (step.status !== "succeeded") {
      continue;
    }
    const entry = { output: step.output, type: step.nodeType, label: step.nodeLabel };
    // Later executions win: in a loop, `{{ planner.plan }}` means the most
    // recent pass, which is what a follow-up node cares about.
    for (const key of stepAliases(step)) {
      steps[key] = entry;
    }
  }

  return {
    input: input.state.input,
    previous: input.previous,
    variables: input.state.variables,
    steps,
    run: {
      id: input.state.runId,
      harnessId: input.state.harnessId,
      harnessVersionId: input.state.harnessVersionId,
      agentId: input.state.agentId,
      iteration: input.iteration,
    },
    now: input.now.toISOString(),
  };
}

/** Keys an output is addressable by: node id, slugged label, and raw label. */
function stepAliases(step: ExecutionStep): string[] {
  const keys = new Set<string>();
  keys.add(step.nodeId);
  keys.add(step.nodeId.toLowerCase());
  const slug = toReferenceKey(step.nodeLabel);
  if (slug !== "") {
    keys.add(slug);
  }
  keys.add(step.nodeLabel);
  return [...keys];
}
