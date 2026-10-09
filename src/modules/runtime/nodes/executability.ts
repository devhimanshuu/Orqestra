/**
 * Executability rules.
 *
 * Phase 2 executes a subset of the DSL with real semantics. Everything else is
 * refused at *compile* time with a specific reason instead of being silently
 * approximated at runtime — a run that cannot honor its harness must not start.
 *
 * Refused today (explicitly, not by accident):
 *  - `human_approval` — human-in-the-loop workflows belong to a later phase and
 *    pausing/resuming a run needs durable suspension, which Phase 2 does not
 *    build. Auto-approving would be worse than refusing.
 *  - `memory` with `session`/`persistent` scope — cross-run memory is a later
 *    phase (Phase 2 memory is run-scoped, in-process, and disposable).
 */

import type { HarnessNodeType } from "@/modules/harness/harness.schema";

export interface ExecutabilityRule {
  /** Node type this rule applies to. */
  type: HarnessNodeType;
  /** Returns a user-facing reason when the config cannot execute, else null. */
  unsupportedReason: (config: Record<string, unknown>) => string | null;
}

const rules: Partial<Record<HarnessNodeType, ExecutabilityRule>> = {
  human_approval: {
    type: "human_approval",
    unsupportedReason: () =>
      "Human approval nodes are not executable in this phase — remove the node or route around it",
  },
  memory: {
    type: "memory",
    unsupportedReason: (config) => {
      const scope = config["scope"];
      if (scope === "session" || scope === "persistent") {
        return `Memory scope "${String(scope)}" is not executable in this phase — use "run" or "step" scope`;
      }
      return null;
    },
  },
};

/** Node types the runtime can execute at all (superset of the rules above). */
export const EXECUTABLE_NODE_TYPES: readonly HarnessNodeType[] = [
  "start",
  "end",
  "model",
  "prompt",
  "planner",
  "critic",
  "evaluator",
  "tool",
  "memory",
  "context",
  "condition",
  "router",
  "loop",
  "transform",
];

/**
 * Returns the reason a node cannot execute in this runtime, or null when it can.
 * The compiler calls this for every node; the first refusal fails the compile.
 */
export function nodeUnsupportedReason(
  type: HarnessNodeType,
  config: Record<string, unknown>,
): string | null {
  if (!EXECUTABLE_NODE_TYPES.includes(type)) {
    return `${type} nodes are not executable in this phase`;
  }
  return rules[type]?.unsupportedReason(config) ?? null;
}
