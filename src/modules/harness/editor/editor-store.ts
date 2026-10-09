"use client";

import { create } from "zustand";
import { NODE_CONFIG_SCHEMAS, type HarnessNodeType } from "../harness.schema";
import { validateHarnessDraft, type HarnessValidationIssue } from "../harness.validation";
import {
  createCanvasNode,
  nextEdgeId,
  reactFlowToHarness,
  type HarnessCanvasEdge,
  type HarnessCanvasNode,
} from "./react-flow-adapter";

/**
 * Client-side editor state for the visual harness builder.
 *
 * Design rules:
 *  - The DSL is the truth: the store holds canvas-shaped nodes/edges and can
 *    always serialize itself back to a `HarnessDraftDocument`.
 *  - Every content mutation bumps `revision`. Autosave watches that counter, so
 *    nothing else needs to diff graphs.
 *  - History is snapshot-based (nodes + edges) and capped; node *positions* are
 *    committed once per drag instead of per mouse move.
 *  - Nothing here talks to the network — see `use-harness-autosave`.
 */

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";
export type ValidationStatus = "unknown" | "valid" | "invalid";
export type BuilderPanel = "inspector" | "validation" | "versions";

type Snapshot = { nodes: HarnessCanvasNode[]; edges: HarnessCanvasEdge[] };

const HISTORY_LIMIT = 60;

export interface EditorInit {
  harnessId: string;
  name: string;
  description: string | null;
  nodes: HarnessCanvasNode[];
  edges: HarnessCanvasEdge[];
  issues: HarnessValidationIssue[];
  validationStatus: ValidationStatus;
}

interface EditorStoreState extends Snapshot {
  harnessId: string;
  harnessName: string;
  harnessDescription: string;
  selectedNodeId: string | null;
  /** Multi-selection mirrored from React Flow (used by duplicate/delete shortcuts). */
  selectedNodeIds: string[];
  selectedEdgeIds: string[];
  activePanel: BuilderPanel;
  past: Snapshot[];
  future: Snapshot[];
  /** Bumped on every content change — drives autosave and dirty state. */
  revision: number;
  /** Revision the server last acknowledged; `revision > savedRevision` = dirty. */
  savedRevision: number;
  issues: HarnessValidationIssue[];
  validationStatus: ValidationStatus;
  validatedAt: number | null;
  saveState: SaveState;
  saveError: string | null;
  savedAt: number | null;
  /** Node the canvas should scroll to (validation panel navigation). */
  focusRequest: { nodeId: string; nonce: number } | null;
  initialized: boolean;
}

interface EditorActions {
  init: (init: EditorInit) => void;
  setName: (name: string) => void;
  setDescription: (description: string) => void;
  setPanel: (panel: BuilderPanel) => void;
  selectNode: (nodeId: string | null) => void;
  setSelection: (selection: { nodes: string[]; edges: string[] }) => void;
  duplicateSelection: () => string[];
  focusNode: (nodeId: string) => void;

  /**
   * Adds a node. With `avoidOverlap` the position is recomputed to a free slot
   * near the graph (used by library clicks, which have no natural drop point);
   * drag-and-drop passes the exact drop position instead.
   */
  addNode: (
    type: HarnessNodeType,
    position: { x: number; y: number },
    options?: { avoidOverlap?: boolean },
  ) => string;
  removeNodes: (nodeIds: string[]) => void;
  duplicateNodes: (nodeIds: string[], offset?: number) => string[];
  /** Records a pre-mutation snapshot so an interaction collapses into one undo step. */
  pushHistory: (snapshot: { nodes: HarnessCanvasNode[]; edges: HarnessCanvasEdge[] }) => void;
  /** Marks content changed without rewriting nodes (used after drags). */
  touch: () => void;
  setNodePosition: (nodeId: string, position: { x: number; y: number }) => void;
  updateNode: (nodeId: string, patch: { label?: string; description?: string }) => void;
  updateNodeConfig: (nodeId: string, config: Record<string, unknown>) => void;

  connect: (connection: {
    source: string;
    target: string;
    sourceHandle?: string | null;
    targetHandle?: string | null;
  }) => void;
  removeEdges: (edgeIds: string[]) => void;

  revalidate: () => void;
  setServerIssues: (issues: HarnessValidationIssue[]) => void;
  applyCanvasNodes: (nodes: HarnessCanvasNode[]) => void;
  applyCanvasEdges: (edges: HarnessCanvasEdge[]) => void;

  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  document: () => ReturnType<typeof reactFlowToHarness>;
  markSaving: () => void;
  markSaved: (revision?: number) => void;
  markSaveError: (message: string) => void;
  reset: () => void;
}

export type EditorStore = EditorStoreState & EditorActions;

function configStatus(
  type: HarnessNodeType,
  config: Record<string, unknown>,
): { invalid: boolean; fieldErrors: Record<string, string> } {
  const schema = NODE_CONFIG_SCHEMAS[type];
  const parsed = schema.safeParse(config);
  if (parsed.success) {
    return { invalid: false, fieldErrors: {} };
  }
  const fieldErrors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path.map((part) => String(part)).join(".") || "config";
    if (!fieldErrors[key]) {
      fieldErrors[key] = issue.message;
    }
  }
  return { invalid: true, fieldErrors };
}

/** Decorates nodes with their own config validity, leaving graph issues to the validator. */
function decorateNodes(nodes: HarnessCanvasNode[]): HarnessCanvasNode[] {
  return nodes.map((node) => {
    const { invalid, fieldErrors } = configStatus(node.data.nodeType, node.data.config);
    return { ...node, data: { ...node.data, configInvalid: invalid, fieldErrors } };
  });
}

const EMPTY_STATE: EditorStoreState = {
  harnessId: "",
  harnessName: "",
  harnessDescription: "",
  nodes: [],
  edges: [],
  selectedNodeId: null,
  selectedNodeIds: [],
  selectedEdgeIds: [],
  activePanel: "inspector",
  past: [],
  future: [],
  revision: 0,
  savedRevision: 0,
  issues: [],
  validationStatus: "unknown",
  validatedAt: null,
  saveState: "idle",
  saveError: null,
  savedAt: null,
  focusRequest: null,
  initialized: false,
};

function truncate(list: Snapshot[]): Snapshot[] {
  return list.length > HISTORY_LIMIT ? list.slice(list.length - HISTORY_LIMIT) : list;
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  ...EMPTY_STATE,

  init: (init) => {
    set({
      ...EMPTY_STATE,
      harnessId: init.harnessId,
      harnessName: init.name,
      harnessDescription: init.description ?? "",
      nodes: decorateNodes(init.nodes),
      edges: init.edges,
      issues: init.issues,
      validationStatus: init.validationStatus,
      saveState: "idle",
      initialized: true,
    });
  },

  setName: (name) =>
    set((state) => ({
      harnessName: name,
      revision: state.revision + 1,
      saveState: "dirty",
    })),

  setDescription: (description) =>
    set((state) => ({
      harnessDescription: description,
      revision: state.revision + 1,
      saveState: "dirty",
    })),

  setPanel: (activePanel) => set({ activePanel }),

  selectNode: (selectedNodeId) => set({ selectedNodeId }),

  setSelection: ({ nodes, edges }) =>
    set((state) => {
      // React Flow owns canvas selection (selectedNodeIds), while the inspector
      // and the single-node actions read selectedNodeId. Without this sync a
      // click highlights a node on the canvas but the inspector keeps editing
      // whichever node was last selected programmatically (e.g. last added).
      const previous = state.selectedNodeId;
      const previousStillExists =
        previous !== null && state.nodes.some((node) => node.id === previous);
      const selectedNodeId =
        nodes.length === 0
          ? previousStillExists
            ? previous
            : null
          : previous !== null && nodes.includes(previous)
            ? previous
            : (nodes[0] ?? null);
      return { selectedNodeIds: nodes, selectedEdgeIds: edges, selectedNodeId };
    }),

  duplicateSelection: () => {
    const state = get();
    const ids =
      state.selectedNodeIds.length > 0
        ? state.selectedNodeIds
        : state.selectedNodeId
          ? [state.selectedNodeId]
          : [];
    if (ids.length === 0) {
      return [];
    }
    return get().duplicateNodes(ids);
  },

  focusNode: (nodeId) =>
    set((state) => ({
      selectedNodeId: nodeId,
      activePanel: "inspector",
      focusRequest: { nodeId, nonce: (state.focusRequest?.nonce ?? 0) + 1 },
    })),

  addNode: (type, position, options) => {
    const state = get();
    const node = createCanvasNode(
      type,
      options?.avoidOverlap === true ? findFreeSlot(state.nodes) : position,
      state.nodes.map((existing) => existing.id),
    );
    const decorated = decorateNodes([node])[0]!;
    set({
      nodes: [...state.nodes, decorated],
      selectedNodeId: decorated.id,
      activePanel: "inspector",
      past: truncate([...state.past, { nodes: state.nodes, edges: state.edges }]),
      future: [],
      revision: state.revision + 1,
      saveState: "dirty",
      validationStatus: "unknown",
    });
    return decorated.id;
  },

  removeNodes: (nodeIds) => {
    if (nodeIds.length === 0) {
      return;
    }
    const state = get();
    const removing = new Set(nodeIds);
    set({
      nodes: state.nodes.filter((node) => !removing.has(node.id)),
      edges: state.edges.filter((edge) => !removing.has(edge.source) && !removing.has(edge.target)),
      selectedNodeId: null,
      past: truncate([...state.past, { nodes: state.nodes, edges: state.edges }]),
      future: [],
      revision: state.revision + 1,
      saveState: "dirty",
      validationStatus: "unknown",
    });
  },

  duplicateNodes: (nodeIds, offset = 48) => {
    const state = get();
    const originals = state.nodes.filter((node) => nodeIds.includes(node.id));
    if (originals.length === 0) {
      return [];
    }
    const takenIds = state.nodes.map((node) => node.id);
    const takenEdgeIds = state.edges.map((edge) => edge.id);
    const created: HarnessCanvasNode[] = [];
    const idMap = new Map<string, string>();

    for (const original of originals) {
      const copy = createCanvasNode(
        original.data.nodeType,
        { x: original.position.x + offset, y: original.position.y + offset },
        takenIds,
      );
      takenIds.push(copy.id);
      idMap.set(original.id, copy.id);
      created.push({
        ...copy,
        data: {
          ...copy.data,
          label: `${original.data.label} copy`.slice(0, 120),
          description: original.data.description,
          config: { ...original.data.config },
        },
      });
    }

    // Re-create edges that live entirely inside the duplicated selection.
    const copiedEdges = state.edges
      .filter((edge) => idMap.has(edge.source) && idMap.has(edge.target))
      .map((edge) => {
        const source = idMap.get(edge.source)!;
        const target = idMap.get(edge.target)!;
        const id = nextEdgeId(source, target, edge.sourceHandle, takenEdgeIds);
        takenEdgeIds.push(id);
        return {
          ...edge,
          id,
          source,
          target,
          selected: false,
          data: edge.data ? { ...edge.data } : undefined,
        };
      });

    const decorated = decorateNodes(created);
    set({
      nodes: [...state.nodes, ...decorated],
      edges: [...state.edges, ...copiedEdges],
      selectedNodeId: decorated[0]?.id ?? null,
      past: truncate([...state.past, { nodes: state.nodes, edges: state.edges }]),
      future: [],
      revision: state.revision + 1,
      saveState: "dirty",
      validationStatus: "unknown",
    });
    return decorated.map((node) => node.id);
  },

  pushHistory: (snapshot) =>
    set((state) => ({
      past: truncate([...state.past, snapshot]),
      future: [],
    })),

  touch: () =>
    set((state) => ({
      revision: state.revision + 1,
      saveState: "dirty",
      validationStatus: "unknown",
    })),

  /** Applies React Flow view changes (drag/dimensions/selection) without touching history. */
  applyCanvasNodes: (nodes: HarnessCanvasNode[]) => set({ nodes }),

  applyCanvasEdges: (edges: HarnessCanvasEdge[]) => set({ edges }),

  setNodePosition: (nodeId, position) =>
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === nodeId ? { ...node, position: { x: position.x, y: position.y } } : node,
      ),
      revision: state.revision + 1,
      saveState: "dirty",
    })),

  updateNode: (nodeId, patch) =>
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === nodeId
          ? {
              ...node,
              data: {
                ...node.data,
                label: patch.label !== undefined ? patch.label : node.data.label,
                description:
                  patch.description !== undefined ? patch.description : node.data.description,
              },
            }
          : node,
      ),
      past: truncate([...state.past, { nodes: state.nodes, edges: state.edges }]),
      future: [],
      revision: state.revision + 1,
      saveState: "dirty",
      validationStatus: "unknown",
    })),

  updateNodeConfig: (nodeId, config) =>
    set((state) => ({
      nodes: decorateNodes(
        state.nodes.map((node) =>
          node.id === nodeId ? { ...node, data: { ...node.data, config } } : node,
        ),
      ),
      past: truncate([...state.past, { nodes: state.nodes, edges: state.edges }]),
      future: [],
      revision: state.revision + 1,
      saveState: "dirty",
      validationStatus: "unknown",
    })),

  connect: ({ source, target, sourceHandle, targetHandle }) => {
    const state = get();
    if (source === target) {
      return;
    }
    const alreadyExists = state.edges.some(
      (edge) =>
        edge.source === source &&
        edge.target === target &&
        (edge.sourceHandle ?? null) === (sourceHandle ?? null),
    );
    if (alreadyExists) {
      return;
    }
    const id = nextEdgeId(
      source,
      target,
      sourceHandle,
      state.edges.map((edge) => edge.id),
    );
    const sourceType = state.nodes.find((node) => node.id === source)?.data.nodeType;
    const branch = sourceHandle && sourceHandle !== "" ? sourceHandle : null;
    const edge: HarnessCanvasEdge = {
      id,
      source,
      target,
      sourceHandle: sourceHandle ?? undefined,
      targetHandle: targetHandle ?? undefined,
      type: "smoothstep",
      data: {
        branch: sourceType === "condition" || sourceType === "loop" ? branch : null,
        label: null,
      },
      label:
        sourceType === "condition" && branch
          ? branch
          : sourceType === "loop" && branch
            ? branch === "body"
              ? "body"
              : "done"
            : undefined,
    };
    set({
      edges: [...state.edges, edge],
      past: truncate([...state.past, { nodes: state.nodes, edges: state.edges }]),
      future: [],
      revision: state.revision + 1,
      saveState: "dirty",
      validationStatus: "unknown",
    });
  },

  removeEdges: (edgeIds) => {
    if (edgeIds.length === 0) {
      return;
    }
    const state = get();
    const removing = new Set(edgeIds);
    set({
      edges: state.edges.filter((edge) => !removing.has(edge.id)),
      past: truncate([...state.past, { nodes: state.nodes, edges: state.edges }]),
      future: [],
      revision: state.revision + 1,
      saveState: "dirty",
      validationStatus: "unknown",
    });
  },

  revalidate: () => {
    const state = get();
    const definition = reactFlowToHarness(state.nodes, state.edges, {
      name: state.harnessName || "Harness",
    });
    const result = validateHarnessDraft(definition);
    const issues = result.ok ? [] : result.issues;

    const errorCounts = new Map<string, number>();
    for (const issue of issues) {
      if (issue.nodeId) {
        errorCounts.set(issue.nodeId, (errorCounts.get(issue.nodeId) ?? 0) + 1);
      }
    }

    set({
      nodes: state.nodes.map((node) => ({
        ...node,
        data: { ...node.data, errorCount: errorCounts.get(node.id) ?? 0 },
      })),
      issues,
      validationStatus: result.ok ? "valid" : "invalid",
      validatedAt: Date.now(),
    });
  },

  setServerIssues: (issues) =>
    set((state) => ({
      issues,
      validationStatus: issues.length === 0 ? "valid" : "invalid",
      validatedAt: Date.now(),
      nodes: state.nodes.map((node) => {
        const count = issues.filter((issue) => issue.nodeId === node.id).length;
        return { ...node, data: { ...node.data, errorCount: count } };
      }),
    })),

  undo: () => {
    const state = get();
    const previous = state.past[state.past.length - 1];
    if (!previous) {
      return;
    }
    set({
      nodes: decorateNodes(previous.nodes),
      edges: previous.edges,
      past: state.past.slice(0, -1),
      future: [...state.future, { nodes: state.nodes, edges: state.edges }],
      revision: state.revision + 1,
      saveState: "dirty",
      validationStatus: "unknown",
      selectedNodeId: null,
    });
  },

  redo: () => {
    const state = get();
    const next = state.future[state.future.length - 1];
    if (!next) {
      return;
    }
    set({
      nodes: decorateNodes(next.nodes),
      edges: next.edges,
      future: state.future.slice(0, -1),
      past: truncate([...state.past, { nodes: state.nodes, edges: state.edges }]),
      revision: state.revision + 1,
      saveState: "dirty",
      validationStatus: "unknown",
      selectedNodeId: null,
    });
  },

  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,

  document: () => {
    const state = get();
    return reactFlowToHarness(state.nodes, state.edges, {
      name: state.harnessName || undefined,
      description: state.harnessDescription || undefined,
    });
  },

  markSaving: () => set({ saveState: "saving", saveError: null }),

  markSaved: (revision) =>
    set((state) => ({
      saveState: "saved",
      saveError: null,
      savedAt: Date.now(),
      savedRevision: revision ?? state.revision,
    })),

  markSaveError: (message) => set({ saveState: "error", saveError: message }),

  reset: () => set({ ...EMPTY_STATE }),
}));

/**
 * Placement geometry for auto-placed nodes. The card width is fixed at 210px
 * (see harness-node.tsx); the box is slightly larger so slots never touch.
 */
const NODE_CARD = { width: 210, height: 92 };
const SLOT_GAP = 44;
const SLOT_COLUMNS = 4;

/**
 * First free slot below the existing graph.
 *
 * Library clicks have no drop position, and the previous behaviour (a fixed
 * diagonal cascade) stacked fresh nodes on top of each other — which also
 * covered their connection handles.
 */
function findFreeSlot(nodes: HarnessCanvasNode[]): { x: number; y: number } {
  if (nodes.length === 0) {
    return { x: 120, y: 140 };
  }
  const originX = Math.min(...nodes.map((node) => node.position.x));
  const originY = Math.max(...nodes.map((node) => node.position.y)) + NODE_CARD.height + SLOT_GAP;

  const collides = (candidate: { x: number; y: number }): boolean =>
    nodes.some(
      (node) =>
        Math.abs(node.position.x - candidate.x) < NODE_CARD.width &&
        Math.abs(node.position.y - candidate.y) < NODE_CARD.height,
    );

  for (let index = 0; index < SLOT_COLUMNS * 8; index += 1) {
    const candidate = {
      x: originX + (index % SLOT_COLUMNS) * (NODE_CARD.width + SLOT_GAP * 0.5),
      y: originY + Math.floor(index / SLOT_COLUMNS) * (NODE_CARD.height + SLOT_GAP),
    };
    if (!collides(candidate)) {
      return candidate;
    }
  }
  return { x: originX, y: originY };
}

/** Convenience selector: the node currently open in the inspector. */
export function useSelectedNode(): HarnessCanvasNode | null {
  return useEditorStore(
    (state) => state.nodes.find((node) => node.id === state.selectedNodeId) ?? null,
  );
}

/** Node type of an arbitrary node id (used for edge labels during connect). */
export function nodeTypeOf(nodes: HarnessCanvasNode[], nodeId: string): HarnessNodeType | null {
  return nodes.find((node) => node.id === nodeId)?.data.nodeType ?? null;
}

export function isDirty(state: EditorStoreState): boolean {
  return state.revision > state.savedRevision;
}
