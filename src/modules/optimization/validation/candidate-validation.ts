/**
 * Candidate validation.
 *
 * A candidate is only allowed to reach execution if its definition passes the
 * *same* validator a published harness passes — the Phase 1 graph validator plus
 * the DSL schema — and the platform's own policy checks on top:
 *
 *  1. the definition validates structurally (reachability, termination, branch
 *     completeness, handle compatibility, entry/exit integrity);
 *  2. entry and exit nodes still exist and were not rewritten by a mutation;
 *  3. the candidate is not empty (a mutation set that changes nothing is not a
 *     candidate);
 *  4. nothing in the change set touches a node the policy forbids (belt and
 *     braces: the mutation engine already refuses these, and this re-checks the
 *     stored change set, because the change set is what gets audited).
 *
 * A failing candidate is recorded as INVALID with its issues — it is never
 * executed, and the baseline is never affected by it.
 */

import { validateHarnessDefinition } from "@/modules/harness/harness.validation";
import type { CandidateValidation, MutationChange } from "../optimization.types";

/** Node types a change set may never remove, whoever wrote the operations. */
const NEVER_REMOVED = ["start", "end", "tool", "human_approval"];

export function validateCandidate(input: {
  definition: unknown;
  changes: readonly MutationChange[];
  /** The baseline's entry/exit ids, checked for integrity. */
  baselineEntryNode: string;
  baselineExitNodes: readonly string[];
}): CandidateValidation {
  const issues: CandidateValidation["issues"] = [];

  if (input.changes.length === 0) {
    issues.push({
      code: "NO_CHANGES",
      message: "The proposal produced no effective change to the harness.",
    });
  }

  for (const change of input.changes) {
    if (change.operation !== "remove_node") {
      continue;
    }
    const before = change.before as { type?: unknown } | null;
    const type = typeof before?.type === "string" ? before.type : null;
    if (type !== null && NEVER_REMOVED.includes(type)) {
      issues.push({
        code: "FORBIDDEN_REMOVAL",
        message: `Change set removes a ${type} node (${change.target}), which the platform forbids.`,
      });
    }
  }

  const result = validateHarnessDefinition(input.definition);
  for (const issue of result.issues) {
    issues.push({ code: issue.code, message: issue.message });
  }

  const definition = result.definition;
  if (definition !== null) {
    if (definition.entryNode !== input.baselineEntryNode) {
      issues.push({
        code: "ENTRY_CHANGED",
        message: `The entry node moved from "${input.baselineEntryNode}" to "${definition.entryNode}".`,
      });
    }
    for (const exitNode of input.baselineExitNodes) {
      if (!definition.exitNodes.includes(exitNode)) {
        issues.push({
          code: "EXIT_REMOVED",
          message: `The exit node "${exitNode}" is missing from the candidate.`,
        });
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    nodeCount: definition?.nodes.length ?? 0,
    edgeCount: definition?.edges.length ?? 0,
    entryNode: definition?.entryNode ?? null,
  };
}

/**
 * Validation of a *draft* candidate before it is published: the same rules, but
 * the service validates drafts with the draft validator (no envelope required).
 */
export function isStructurallySafe(validation: CandidateValidation): boolean {
  return validation.ok;
}
