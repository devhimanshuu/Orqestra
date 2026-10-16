/**
 * Mutation engine.
 *
 * Takes a harness definition plus typed operations and returns a *new*
 * definition with a complete change set. The input definition is never mutated:
 * the caller's baseline stays byte-identical, which is what makes "the published
 * harness was not touched" a property of the code rather than a promise.
 *
 * Every refusal is recorded with its reason (`rejected`), so an invalid proposal
 * is auditable instead of vanishing.
 *
 * Restrictions enforced here, in one place:
 *
 *  - unknown nodes/edges are refused (no invented targets);
 *  - prompt writes are limited to textual fields the node type actually owns;
 *  - numeric writes are limited to an allowlist of behaviour knobs, inside the
 *    runtime's own ranges — tool permissions, providers, credentials and model
 *    identity are unreachable;
 *  - graph edits may only insert or remove behaviour-only node kinds
 *    (critic/prompt/transform), which are the only types with an unambiguous
 *    single input and single unnamed output;
 *  - never `start`/`end` (entry/exit integrity), never `tool` (permissions),
 *    never `human_approval` (governance);
 *  - reconnection refuses self-loops, duplicate edges and edges into nodes that
 *    accept no input.
 */

import { getHandleSpec, NODE_CONFIG_SCHEMAS, type HarnessNodeType } from "@/modules/harness/harness.schema";
import { hashJson } from "@/modules/evaluation/hashing";
import type { MutationApplication, MutationChange, MutationRisk } from "../optimization.types";
import {
  assessRisk,
  numericFieldPolicy,
  promptFieldAllowed,
  type MutationOperation,
} from "./operations";

interface RawNode {
  id: string;
  type: string;
  label?: string;
  position?: { x: number; y: number };
  description?: string;
  config: Record<string, unknown>;
}

interface RawEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  label?: string;
}

interface RawDefinition {
  nodes: RawNode[];
  edges: RawEdge[];
  entryNode?: string;
  exitNodes?: string[];
  [key: string]: unknown;
}

/** Node kinds the engine may add *and* remove — behaviour-only, single in/out. */
const EDITABLE_NODE_TYPES: readonly string[] = ["critic", "prompt", "transform"];

function asDefinition(value: unknown): RawDefinition | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record["nodes"]) || !Array.isArray(record["edges"])) {
    return null;
  }
  return structuredClone(value) as RawDefinition;
}

function findNode(definition: RawDefinition, nodeId: string): RawNode | null {
  return definition.nodes.find((node) => node.id === nodeId) ?? null;
}

function findEdge(definition: RawDefinition, edgeId: string): RawEdge | null {
  return definition.edges.find((edge) => edge.id === edgeId) ?? null;
}

/** Validates one node's config against its type's schema. */
function validateNodeConfig(
  nodeType: string,
  config: Record<string, unknown>,
): { ok: true } | { ok: false; issues: string[] } {
  const schema = (NODE_CONFIG_SCHEMAS as Record<string, import("zod").ZodType>)[nodeType];
  if (schema === undefined) {
    return { ok: false, issues: [`unknown node type "${nodeType}"`] };
  }
  const parsed = schema.safeParse(config);
  if (parsed.success) {
    return { ok: true };
  }
  return {
    ok: false,
    issues: parsed.error.issues.map(
      (issue) => `${issue.path.map(String).join(".") || "(config)"}: ${issue.message}`,
    ),
  };
}

interface Applied {
  change: MutationChange;
}

interface Rejected {
  operation: string;
  target: string;
  reason: string;
}

function reject(operation: MutationOperation, target: string, reason: string): Rejected {
  return { operation: operation.op, target, reason };
}

/** Applies one operation in place on the working copy. */
function applyOne(
  definition: RawDefinition,
  operation: MutationOperation,
): Applied | Rejected {
  switch (operation.op) {
    case "set_prompt_instruction": {
      const node = findNode(definition, operation.nodeId);
      if (node === null) {
        return reject(operation, operation.nodeId, `no node "${operation.nodeId}" in this harness`);
      }
      if (!promptFieldAllowed(node.type, operation.field)) {
        return reject(
          operation,
          `${node.id}.config.${operation.field}`,
          `a ${node.type} node has no "${operation.field}" field to write`,
        );
      }
      const current = typeof node.config[operation.field] === "string" ? (node.config[operation.field] as string) : "";
      const next =
        operation.mode === "replace"
          ? operation.value
          : operation.mode === "prepend"
            ? current === ""
              ? operation.value
              : `${operation.value}\n\n${current}`
            : current === ""
              ? operation.value
              : `${current}\n\n${operation.value}`;
      if (next === current) {
        return reject(operation, `${node.id}.config.${operation.field}`, "no change");
      }
      const merged = { ...node.config, [operation.field]: next };
      const valid = validateNodeConfig(node.type, merged);
      if (!valid.ok) {
        return reject(
          operation,
          `${node.id}.config.${operation.field}`,
          `resulting config is invalid — ${valid.issues.join("; ")}`,
        );
      }
      node.config = merged;
      return {
        change: {
          operation: operation.op,
          target: `nodes.${node.id}.config.${operation.field}`,
          before: current,
          after: next,
          reason: operation.reason,
          risk: assessRisk(operation),
        },
      };
    }

    case "set_node_config": {
      const node = findNode(definition, operation.nodeId);
      if (node === null) {
        return reject(operation, operation.nodeId, `no node "${operation.nodeId}" in this harness`);
      }
      const policy = numericFieldPolicy(node.type, operation.key);
      if (policy === null) {
        return reject(
          operation,
          `${node.id}.config.${operation.key}`,
          `"${operation.key}" is not a mutable field on a ${node.type} node`,
        );
      }
      if (policy.integer && !Number.isInteger(operation.value)) {
        return reject(
          operation,
          `${node.id}.config.${operation.key}`,
          `"${operation.key}" must be an integer`,
        );
      }
      if (operation.value < policy.min || operation.value > policy.max) {
        return reject(
          operation,
          `${node.id}.config.${operation.key}`,
          `"${operation.key}" must be within [${policy.min}, ${policy.max}]`,
        );
      }
      const before = typeof node.config[operation.key] === "number" ? (node.config[operation.key] as number) : null;
      if (before === operation.value) {
        return reject(operation, `${node.id}.config.${operation.key}`, "no change");
      }
      const merged = { ...node.config, [operation.key]: operation.value };
      const valid = validateNodeConfig(node.type, merged);
      if (!valid.ok) {
        return reject(
          operation,
          `${node.id}.config.${operation.key}`,
          `resulting config is invalid — ${valid.issues.join("; ")}`,
        );
      }
      node.config = merged;
      return {
        change: {
          operation: operation.op,
          target: `nodes.${node.id}.config.${operation.key}`,
          before,
          after: operation.value,
          reason: operation.reason,
          risk: assessRisk(operation, { before, nodeType: node.type }),
        },
      };
    }

    case "insert_node": {
      if (findNode(definition, operation.nodeId) !== null) {
        return reject(operation, operation.nodeId, `node "${operation.nodeId}" already exists`);
      }
      const edge = findEdge(definition, operation.edgeId);
      if (edge === null) {
        return reject(operation, operation.edgeId, `no edge "${operation.edgeId}" in this harness`);
      }
      if (!EDITABLE_NODE_TYPES.includes(operation.nodeType)) {
        return reject(
          operation,
          operation.nodeType,
          `only ${EDITABLE_NODE_TYPES.join("/")} nodes may be inserted`,
        );
      }
      const handles = getHandleSpec(operation.nodeType as HarnessNodeType);
      if (!handles.input || handles.outputs.length !== 1 || handles.outputs[0] !== "") {
        return reject(
          operation,
          operation.nodeType,
          `a ${operation.nodeType} node does not have a single unnamed input/output`,
        );
      }
      const configCheck = validateNodeConfig(operation.nodeType, operation.config);
      if (!configCheck.ok) {
        return reject(operation, operation.nodeId, `invalid config — ${configCheck.issues.join("; ")}`);
      }

      const source = findNode(definition, edge.source);
      const target = findNode(definition, edge.target);
      const midpoint = {
        x: Math.round(((source?.position?.x ?? 0) + (target?.position?.x ?? 0)) / 2),
        y: Math.round(((source?.position?.y ?? 0) + (target?.position?.y ?? 0)) / 2),
      };
      const node: RawNode = {
        id: operation.nodeId,
        type: operation.nodeType,
        label: operation.label,
        position: midpoint,
        config: operation.config,
      };
      definition.nodes.push(node);
      // Split the edge: source → new node → original target. The source's own
      // branch handle is preserved; the new node has a single unnamed output.
      const originalSourceHandle = edge.sourceHandle;
      edge.target = node.id;
      delete edge.targetHandle;
      definition.edges.push({
        id: `${edge.id}~${node.id}`,
        source: node.id,
        target: target?.id ?? node.id,
        ...(edge.targetHandle !== undefined ? { targetHandle: edge.targetHandle } : {}),
      });
      return {
        change: {
          operation: operation.op,
          target: `nodes.${node.id}`,
          before: null,
          after: {
            node: { id: node.id, type: node.type, label: node.label, config: node.config },
            splitEdgeId: edge.id,
            sourceHandle: originalSourceHandle ?? null,
          },
          reason: operation.reason,
          risk: assessRisk(operation),
        },
      };
    }

    case "remove_node": {
      const node = findNode(definition, operation.nodeId);
      if (node === null) {
        return reject(operation, operation.nodeId, `no node "${operation.nodeId}" in this harness`);
      }
      if (!EDITABLE_NODE_TYPES.includes(node.type)) {
        return reject(
          operation,
          node.id,
          `a ${node.type} node is required by the harness and cannot be removed`,
        );
      }
      const incoming = definition.edges.filter((edge) => edge.target === node.id);
      const outgoing = definition.edges.filter((edge) => edge.source === node.id);
      if (incoming.length !== 1 || outgoing.length !== 1) {
        return reject(
          operation,
          node.id,
          `reconnection is ambiguous (${incoming.length} in, ${outgoing.length} out)`,
        );
      }
      const inEdge = incoming[0] as RawEdge;
      const outEdge = outgoing[0] as RawEdge;
      const predecessor = findNode(definition, inEdge.source);
      const successor = findNode(definition, outEdge.target);
      if (predecessor === null || successor === null) {
        return reject(operation, node.id, "the node's neighbours are missing from the graph");
      }
      if (inEdge.source === outEdge.target) {
        // Removing a self-mediated cycle would create a direct self-loop.
        return reject(operation, node.id, "removing this node would create a self-loop");
      }

      definition.nodes = definition.nodes.filter((entry) => entry.id !== node.id);
      definition.edges = definition.edges.filter(
        (edge) => edge.id !== inEdge.id && edge.id !== outEdge.id,
      );
      definition.edges.push({
        id: `${inEdge.id}~reconnect`,
        source: inEdge.source,
        target: outEdge.target,
        ...(inEdge.sourceHandle !== undefined ? { sourceHandle: inEdge.sourceHandle } : {}),
        ...(outEdge.targetHandle !== undefined ? { targetHandle: outEdge.targetHandle } : {}),
      });
      return {
        change: {
          operation: operation.op,
          target: `nodes.${node.id}`,
          before: { id: node.id, type: node.type, label: node.label, config: node.config },
          after: { removedEdges: [inEdge.id, outEdge.id], reconnected: `${inEdge.source} → ${outEdge.target}` },
          reason: operation.reason,
          risk: assessRisk(operation),
        },
      };
    }

    case "reconnect_edge": {
      const edge = findEdge(definition, operation.edgeId);
      if (edge === null) {
        return reject(operation, operation.edgeId, `no edge "${operation.edgeId}" in this harness`);
      }
      const target = findNode(definition, operation.target);
      if (target === null) {
        return reject(operation, operation.target, `no node "${operation.target}" in this harness`);
      }
      if (target.id === edge.source) {
        return reject(operation, operation.edgeId, "an edge cannot point at its own source");
      }
      const handles = getHandleSpec(target.type as HarnessNodeType);
      if (!handles.input) {
        return reject(operation, operation.target, `a ${target.type} node accepts no input`);
      }
      const duplicate = definition.edges.some(
        (entry) =>
          entry.id !== edge.id && entry.source === edge.source && entry.target === operation.target,
      );
      if (duplicate) {
        return reject(operation, operation.edgeId, "that edge already exists");
      }
      const before = { source: edge.source, target: edge.target };
      edge.target = target.id;
      delete edge.targetHandle;
      return {
        change: {
          operation: operation.op,
          target: `edges.${edge.id}`,
          before,
          after: { source: edge.source, target: target.id },
          reason: operation.reason,
          risk: assessRisk(operation),
        },
      };
    }

    default:
      return reject(operation as MutationOperation, "unknown", "unsupported operation");
  }
}

/**
 * Applies a sequence of operations to a definition.
 *
 * Operations are applied in order; a rejected operation does not abort the
 * others, so a five-operation proposal where one is illegal still yields a
 * candidate made of the four legal changes — with the refusal on the record.
 */
export function applyMutations(
  definition: unknown,
  operations: readonly MutationOperation[],
): MutationApplication {
  const working = asDefinition(definition);
  if (working === null) {
    return {
      definition,
      applied: [],
      rejected: operations.map((operation) => ({
        operation: operation.op,
        target: "definition",
        reason: "the definition is not a harness graph",
      })),
    };
  }

  const applied: MutationChange[] = [];
  const rejected: Rejected[] = [];
  for (const operation of operations) {
    const outcome = applyOne(working, operation);
    if ("change" in outcome) {
      applied.push(outcome.change);
    } else {
      rejected.push(outcome);
    }
  }

  return { definition: working, applied, rejected };
}

/**
 * A stable fingerprint of an applied change set.
 *
 * Two proposals that end up making the same edits hash identically, which is how
 * the loop avoids re-evaluating an equivalent candidate. Only the *effect* is
 * hashed (target + after), not the wording of the reason — two hypotheses that
 * change the same field the same way are the same candidate.
 */
export function mutationFingerprint(
  baselineContentHash: string,
  changes: readonly MutationChange[],
): string {
  const normalized = changes
    .map((change) => ({ target: change.target, after: change.after }))
    .sort((a, b) => a.target.localeCompare(b.target));
  return hashJson({ baseline: baselineContentHash, changes: normalized });
}

/** Total ordering value for the change set, so no-op proposals are detectable. */
export function hasEffectiveChange(changes: readonly MutationChange[]): boolean {
  return changes.length > 0;
}

export function riskRank(risk: MutationRisk): number {
  return risk === "HIGH" ? 2 : risk === "MEDIUM" ? 1 : 0;
}

/** The riskiest change in a set — a candidate is as risky as its boldest edit. */
export function highestRisk(changes: readonly MutationChange[]): MutationRisk {
  let worst: MutationRisk = "LOW";
  for (const change of changes) {
    if (riskRank(change.risk) > riskRank(worst)) {
      worst = change.risk;
    }
  }
  return worst;
}
