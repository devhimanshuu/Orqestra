import type { Edge, Node } from "@xyflow/react";
import {
  getHandleSpec,
  harnessDraftDocumentSchema,
  harnessDraftNodeSchema,
  type HarnessDefinition,
  type HarnessDraftDocument,
  type HarnessEdge,
  type HarnessNodeType,
} from "../harness.schema";
import { NODE_CATALOG } from "./node-catalog";

/**
 * Harness DSL ⇄ React Flow adapter.
 *
 * React Flow is only the editor. The harness DSL is the product representation,
 * so nothing outside this module may assume React Flow structures: the canvas
 * talks in `HarnessCanvasNode`/`HarnessCanvasEdge`, persistence talks in
 * `HarnessDraftDocument`/`HarnessDefinition`.
 *
 * `reactFlowToHarness` is intentionally total: it takes whatever the canvas
 * currently holds (including a half-finished graph) and produces a draft
 * document. Correctness is decided by `validateHarnessDefinition`, never here.
 */

/** Editor-only payload stored on each React Flow node. */
export type HarnessCanvasNodeData = {
  nodeType: HarnessNodeType;
  label: string;
  description: string;
  config: Record<string, unknown>;
  /** Validation issues anchored to this node, surfaced as a badge on the card. */
  errorCount: number;
  /** True while the node's config fails its own schema (inspector highlight). */
  configInvalid: boolean;
  /** Field-level messages from the node's config schema, keyed by config path. */
  fieldErrors: Record<string, string>;
};

export type HarnessCanvasNode = Node<HarnessCanvasNodeData, "harness">;
export type HarnessCanvasEdge = Edge<{ branch: string | null; label: string | null }>;

export const CANVAS_NODE_TYPE = "harness" as const;

function branchFor(type: HarnessNodeType, handle: string | null | undefined): string | null {
  const spec = getHandleSpec(type);
  const named = spec.outputs.filter((output) => output !== "");
  if (named.length === 0) {
    return null;
  }
  return handle && named.includes(handle) ? handle : null;
}

export function branchLabel(sourceType: HarnessNodeType, branch: string | null): string | null {
  if (!branch) {
    return null;
  }
  if (sourceType === "condition") {
    return branch === "true" ? "true" : "false";
  }
  if (sourceType === "loop") {
    return branch === "body" ? "body" : "done";
  }
  return branch;
}

/** Keys that react-flow owns; everything else is harness data. */
export function canvasNodeFromDraft(node: {
  id: string;
  type: HarnessNodeType;
  label: string;
  description?: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
}): HarnessCanvasNode {
  const meta = NODE_CATALOG[node.type];
  return {
    id: node.id,
    type: CANVAS_NODE_TYPE,
    position: { x: node.position.x, y: node.position.y },
    data: {
      nodeType: node.type,
      label: node.label || meta.label,
      description: node.description ?? meta.defaultDescription,
      config: node.config,
      errorCount: 0,
      configInvalid: false,
      fieldErrors: {},
    },
  };
}

function canvasEdgeFromDraft(edge: HarnessEdge, sourceType?: HarnessNodeType): HarnessCanvasEdge {
  const branch = sourceType ? branchFor(sourceType, edge.sourceHandle) : (edge.sourceHandle ?? null);
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? (branch ?? undefined),
    targetHandle: edge.targetHandle,
    type: "smoothstep",
    animated: false,
    label: edge.label ?? (sourceType ? (branchLabel(sourceType, branch) ?? undefined) : undefined),
    data: { branch, label: edge.label ?? null },
  };
}

/** A valid harness definition → canvas state. */
export function harnessToReactFlow(definition: HarnessDefinition): {
  nodes: HarnessCanvasNode[];
  edges: HarnessCanvasEdge[];
} {
  const typeById = new Map(definition.nodes.map((node) => [node.id, node.type]));
  return {
    nodes: definition.nodes.map((node) => canvasNodeFromDraft(node)),
    edges: definition.edges.map((edge) => canvasEdgeFromDraft(edge, typeById.get(edge.source))),
  };
}

export interface CanvasMeta {
  id?: string;
  name?: string;
  description?: string;
  version?: number;
}

/** Canvas state → harness draft document (entry/exit derived from node types). */
export function reactFlowToHarness(
  nodes: HarnessCanvasNode[],
  edges: HarnessCanvasEdge[],
  meta: CanvasMeta = {},
): HarnessDraftDocument {
  const startNodes = nodes.filter((node) => node.data.nodeType === "start");
  const endNodes = nodes.filter((node) => node.data.nodeType === "end");

  const document: HarnessDraftDocument = {
    schemaVersion: 2,
    ...(meta.id ? { id: meta.id } : {}),
    ...(meta.name ? { name: meta.name } : {}),
    ...(meta.description ? { description: meta.description } : {}),
    ...(meta.version ? { version: meta.version } : {}),
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.data.nodeType,
      label: node.data.label || NODE_CATALOG[node.data.nodeType].label,
      description: node.data.description || undefined,
      position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
      config: node.data.config,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
      ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
      ...(edge.data?.label ? { label: edge.data.label } : {}),
    })),
    ...(startNodes.length === 1 ? { entryNode: startNodes[0]!.id } : {}),
    ...(endNodes.length > 0 ? { exitNodes: endNodes.map((node) => node.id).slice(0, 20) } : {}),
  };

  return document;
}

export interface CoercedDocument {
  nodes: HarnessCanvasNode[];
  edges: HarnessCanvasEdge[];
  entryNode: string | null;
  exitNodes: string[];
  name?: string;
  description?: string;
  droppedNodes: number;
  droppedEdges: number;
  adjustedEdges: number;
}

/**
 * Lenient reader: turns *anything* (a draft mid-edit, an imported file, an old
 * definition) into canvas state without throwing. Unknown nodes and edges that
 * point at nothing are dropped and counted so the UI can explain what happened.
 */
export function coerceHarnessDocument(input: unknown): CoercedDocument {
  const parsed = harnessDraftDocumentSchema.safeParse(input);
  const result: CoercedDocument = {
    nodes: [],
    edges: [],
    entryNode: null,
    exitNodes: [],
    droppedNodes: 0,
    droppedEdges: 0,
    adjustedEdges: 0,
  };

  if (!parsed.success) {
    // Even the loose draft shape failed: salvage node-by-node.
    const raw = (input ?? {}) as { nodes?: unknown; edges?: unknown };
    const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
    const rawEdges = Array.isArray(raw.edges) ? raw.edges : [];
    for (const candidate of rawNodes) {
      const node = harnessDraftNodeSchema.safeParse(candidate);
      if (node.success) {
        result.nodes.push(canvasNodeFromDraft(node.data));
      } else {
        result.droppedNodes += 1;
      }
    }
    for (const candidate of rawEdges) {
      const edge = harnessNodeEdgeFallback(candidate);
      if (edge) {
        result.edges.push(edge);
        result.adjustedEdges += 1;
      } else {
        result.droppedEdges += 1;
      }
    }
    return result;
  }

  const document = parsed.data;
  result.name = document.name;
  result.description = document.description;

  for (const node of document.nodes) {
    result.nodes.push(canvasNodeFromDraft(node));
  }
  result.entryNode = document.entryNode ?? null;
  result.exitNodes = document.exitNodes ?? [];

  const byId = new Map(result.nodes.map((node) => [node.id, node]));
  const seenEdgeIds = new Set<string>();
  for (const edge of document.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) {
      result.droppedEdges += 1;
      continue;
    }
    const spec = getHandleSpec(source.data.nodeType);
    const named = spec.outputs.filter((output) => output !== "");
    let edgeToAdd = edge;
    if (named.length > 0 && (!edge.sourceHandle || !named.includes(edge.sourceHandle))) {
      // Keep the connection, repair the branch, and let validation report it.
      edgeToAdd = { ...edge, sourceHandle: named[0] };
      result.adjustedEdges += 1;
    }
    const id = seenEdgeIds.has(edgeToAdd.id)
      ? `${edgeToAdd.id}-${result.edges.length + 1}`
      : edgeToAdd.id;
    seenEdgeIds.add(id);
    result.edges.push(canvasEdgeFromDraft({ ...edgeToAdd, id }, source.data.nodeType));
  }

  return result;
}

function harnessNodeEdgeFallback(candidate: unknown): HarnessCanvasEdge | null {
  if (typeof candidate !== "object" || candidate === null) {
    return null;
  }
  const edge = candidate as Partial<HarnessEdge>;
  if (typeof edge.source !== "string" || typeof edge.target !== "string") {
    return null;
  }
  return {
    id: typeof edge.id === "string" && edge.id.length > 0 ? edge.id : `e-${edge.source}-${edge.target}`,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    type: "smoothstep",
    data: { branch: edge.sourceHandle ?? null, label: edge.label ?? null },
  };
}

/** Unique node id for a freshly created node of `type`. */
export function nextNodeId(type: HarnessNodeType, existingIds: Iterable<string>): string {
  const taken = new Set(existingIds);
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${type}-${index}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  return `${type}-${Date.now().toString(36)}`;
}

/** Unique edge id for a connection. */
export function nextEdgeId(
  source: string,
  target: string,
  sourceHandle: string | null | undefined,
  existingIds: Iterable<string>,
): string {
  const taken = new Set(existingIds);
  const base = `e-${source}${sourceHandle ? `-${sourceHandle}` : ""}-${target}`;
  if (!taken.has(base)) {
    return base;
  }
  for (let index = 2; index < 1000; index += 1) {
    if (!taken.has(`${base}-${index}`)) {
      return `${base}-${index}`;
    }
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** A brand-new node placed by the library (cascade so stacked drops stay visible). */
export function createCanvasNode(
  type: HarnessNodeType,
  position: { x: number; y: number },
  existingIds: Iterable<string>,
): HarnessCanvasNode {
  const meta = NODE_CATALOG[type];
  return {
    id: nextNodeId(type, existingIds),
    type: CANVAS_NODE_TYPE,
    position,
    data: {
      nodeType: type,
      label: meta.defaultLabel,
      description: meta.defaultDescription,
      config: { ...meta.defaultConfig },
      errorCount: 0,
      configInvalid: false,
      fieldErrors: {},
    },
  };
}

export type { HarnessDraftDocument };
