"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type EdgeChange,
  type NodeChange,
  type OnConnect,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { HARNESS_NODE_TYPES, type HarnessNodeType } from "@/modules/harness/harness.schema";
import { NODE_CATALOG } from "@/modules/harness/editor/node-catalog";
import { useEditorStore } from "@/modules/harness/editor/editor-store";
import type {
  HarnessCanvasEdge,
  HarnessCanvasNode,
} from "@/modules/harness/editor/react-flow-adapter";
import { HarnessNodeCard } from "./harness-node";

const NODE_TYPES = { harness: HarnessNodeCard };
export const NODE_DRAG_MIME = "application/orqestra-node-type";

const DEFAULT_VIEWPORT = { x: 40, y: 60, zoom: 0.9 };

/**
 * The harness canvas.
 *
 * React Flow is driven in controlled mode straight from the editor store: view
 * changes (drag, dimensions, selection) are applied locally, while *content*
 * changes (add/remove/connect/config) go through store actions that bump the
 * autosave revision.
 */
export function BuilderCanvas() {
  const nodes = useEditorStore((state) => state.nodes);
  const edges = useEditorStore((state) => state.edges);
  const focusRequest = useEditorStore((state) => state.focusRequest);
  const { screenToFlowPosition, fitView } = useReactFlow();
  const dragSnapshot = useRef<{ nodes: HarnessCanvasNode[]; edges: HarnessCanvasEdge[] } | null>(null);

  const onNodesChange = useCallback((changes: NodeChange<HarnessCanvasNode>[]) => {
    const viewChanges = changes.filter(
      (change) => change.type === "position" || change.type === "dimensions" || change.type === "select",
    );
    if (viewChanges.length === 0) {
      return;
    }
    const store = useEditorStore.getState();
    store.applyCanvasNodes(applyNodeChanges(viewChanges, store.nodes));
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange<HarnessCanvasEdge>[]) => {
    const viewChanges = changes.filter((change) => change.type === "select");
    if (viewChanges.length === 0) {
      return;
    }
    const store = useEditorStore.getState();
    store.applyCanvasEdges(applyEdgeChanges(viewChanges, store.edges));
  }, []);

  const onConnect = useCallback<OnConnect>((connection) => {
    useEditorStore.getState().connect({
      source: connection.source,
      target: connection.target,
      sourceHandle: connection.sourceHandle,
      targetHandle: connection.targetHandle,
    });
  }, []);

  const onSelectionChange = useCallback((params: OnSelectionChangeParams) => {
    useEditorStore.getState().setSelection({
      nodes: params.nodes.map((node) => node.id),
      edges: params.edges.map((edge) => edge.id),
    });
  }, []);

  const onNodeDragStart = useCallback(() => {
    const state = useEditorStore.getState();
    dragSnapshot.current = { nodes: state.nodes, edges: state.edges };
  }, []);

  const onNodesDelete = useCallback((removed: HarnessCanvasNode[]) => {
    useEditorStore.getState().removeNodes(removed.map((node) => node.id));
  }, []);

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const rawType = event.dataTransfer.getData(NODE_DRAG_MIME);
      if (!rawType || !HARNESS_NODE_TYPES.includes(rawType as HarnessNodeType)) {
        return;
      }
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const id = useEditorStore.getState().addNode(rawType as HarnessNodeType, position);
      void fitView({ nodes: [{ id }], duration: 250, padding: 0.3 });
    },
    [fitView, screenToFlowPosition],
  );

  // Undo step for a drag: only recorded when a node actually moved.
  const onNodesDragStop = useCallback(() => {
    const snapshot = dragSnapshot.current;
    dragSnapshot.current = null;
    if (!snapshot) {
      return;
    }
    const current = useEditorStore.getState().nodes;
    const before = new Map(snapshot.nodes.map((node) => [node.id, node.position]));
    const moved = current.some((node) => {
      const previous = before.get(node.id);
      if (!previous) {
        return false;
      }
      return Math.round(previous.x) !== Math.round(node.position.x) ||
        Math.round(previous.y) !== Math.round(node.position.y);
    });
    if (moved) {
      useEditorStore.getState().pushHistory(snapshot);
      useEditorStore.getState().touch();
    }
  }, []);

  // Validation panel click-through → reveal the offending node.
  useEffect(() => {
    if (!focusRequest) {
      return;
    }
    void fitView({
      nodes: [{ id: focusRequest.nodeId }],
      duration: 300,
      padding: 0.6,
      maxZoom: 1.2,
    });
  }, [fitView, focusRequest]);

  const defaultEdgeOptions = useMemo(
    () => ({
      type: "smoothstep" as const,
      style: { strokeWidth: 1.6 },
      labelStyle: { fontSize: 10, fill: "currentColor" },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
    }),
    [],
  );

  return (
    <ReactFlow<HarnessCanvasNode, HarnessCanvasEdge>
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      defaultViewport={DEFAULT_VIEWPORT}
      defaultEdgeOptions={defaultEdgeOptions}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onSelectionChange={onSelectionChange}
      onNodeDragStart={onNodeDragStart}
      onNodeDragStop={onNodesDragStop}
      onNodesDelete={onNodesDelete}
      onDragOver={onDragOver}
      onDrop={onDrop}
      deleteKeyCode={null}
      multiSelectionKeyCode={["Meta", "Control", "Shift"]}
      selectionKeyCode="Shift"
      panActivationKeyCode="Space"
      selectionOnDrag={false}
      minZoom={0.2}
      maxZoom={2}
      fitView
      fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
      connectionRadius={28}
      className="bg-muted/20"
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1.4} color="currentColor" className="opacity-40" />
      <Controls
        position="bottom-left"
        showInteractive={false}
        className="!rounded-md !border !bg-card !shadow-sm [&>button]:!border-border [&>button]:!bg-card"
      />
      <MiniMap
        position="bottom-right"
        pannable
        zoomable
        nodeStrokeWidth={2}
        className="!rounded-md !border !bg-card"
        nodeColor={(node) => NODE_CATALOG[(node as HarnessCanvasNode).data.nodeType].accent}
      />
    </ReactFlow>
  );
}
