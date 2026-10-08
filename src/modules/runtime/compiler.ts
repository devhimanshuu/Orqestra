import type { HarnessDefinition, HarnessEdge, HarnessNode } from "@/modules/harness/harness.schema";
import {
  validateHarnessDefinition,
  type HarnessValidationIssue,
} from "@/modules/harness/harness.validation";
import { hashHarnessDefinition } from "@/modules/harness/harness.serialize";

/**
 * Harness compiler (Phase 0 shape).
 *
 * validate → normalize → ExecutionPlan. The plan is the runtime's input:
 * an adjacency-indexed, immutable view of a validated definition, pinned to
 * its content hash for reproducibility. Phase 2 adds scheduling/optimization
 * passes without changing this contract.
 */

export interface ExecutionPlan {
  schemaVersion: number;
  /** SHA-256 of the canonical definition — ties every run to exact behavior. */
  contentHash: string;
  entryNode: string;
  exitNodes: string[];
  nodes: HarnessNode[];
  edges: HarnessEdge[];
  /** nodeId → ordered target node ids (outgoing edges). */
  adjacency: Record<string, string[]>;
}

export type CompileResult =
  | { ok: true; plan: ExecutionPlan; issues: [] }
  | { ok: false; plan: null; issues: HarnessValidationIssue[] };

export function compileHarness(input: unknown): CompileResult {
  const validation = validateHarnessDefinition(input);
  if (!validation.ok) {
    return { ok: false, plan: null, issues: validation.issues };
  }

  const definition: HarnessDefinition = validation.definition;
  const adjacency: Record<string, string[]> = {};
  for (const node of definition.nodes) {
    adjacency[node.id] = [];
  }
  for (const edge of definition.edges) {
    adjacency[edge.source]?.push(edge.target);
  }

  return {
    ok: true,
    issues: [],
    plan: {
      schemaVersion: definition.schemaVersion,
      contentHash: hashHarnessDefinition(definition),
      entryNode: definition.entryNode,
      exitNodes: [...definition.exitNodes],
      nodes: definition.nodes,
      edges: definition.edges,
      adjacency,
    },
  };
}
