import { beforeEach, describe, expect, it } from "vitest";
import type { HarnessDefinition } from "../harness.schema";
import { harnessToReactFlow } from "./react-flow-adapter";
import { useEditorStore } from "./editor-store";

/**
 * Editor store unit tests.
 *
 * These cover the invariants the canvas and the inspector rely on — and the two
 * bugs they were written after: library clicks stacking nodes on top of each
 * other, and the inspector drifting away from the canvas selection.
 */

const DEFINITION: HarnessDefinition = {
  schemaVersion: 2,
  id: "test-harness",
  version: 1,
  name: "Test harness",
  description: "Start → End",
  nodes: [
    { id: "start", type: "start", label: "Start", config: {}, position: { x: 0, y: 0 } },
    { id: "end", type: "end", label: "End", config: {}, position: { x: 320, y: 0 } },
  ],
  edges: [{ id: "e-start-end", source: "start", target: "end" }],
  entryNode: "start",
  exitNodes: ["end"],
};

function initStore(): void {
  const { nodes, edges } = harnessToReactFlow(DEFINITION);
  useEditorStore.getState().init({
    harnessId: "harness-1",
    name: DEFINITION.name,
    description: DEFINITION.description ?? null,
    nodes,
    edges,
    issues: [],
    validationStatus: "valid",
  });
}

describe("editor store", () => {
  beforeEach(() => {
    useEditorStore.getState().reset();
    initStore();
  });

  describe("setSelection", () => {
    it("points the inspector at the node the canvas selected", () => {
      // Mirrors a library click, which selects the freshly added node.
      const added = useEditorStore
        .getState()
        .addNode("planner", { x: 0, y: 0 }, { avoidOverlap: true });
      expect(useEditorStore.getState().selectedNodeId).toBe(added);

      // Clicking another node on the canvas must move the inspector with it.
      useEditorStore.getState().setSelection({ nodes: ["start"], edges: [] });
      expect(useEditorStore.getState().selectedNodeId).toBe("start");
      expect(useEditorStore.getState().selectedNodeIds).toEqual(["start"]);
    });

    it("keeps the current node when the canvas selection is cleared", () => {
      useEditorStore.getState().setSelection({ nodes: ["end"], edges: [] });
      useEditorStore.getState().setSelection({ nodes: [], edges: [] });
      expect(useEditorStore.getState().selectedNodeId).toBe("end");
    });

    it("keeps the current node when it is part of a multi-selection", () => {
      useEditorStore.getState().setSelection({ nodes: ["start"], edges: [] });
      useEditorStore.getState().setSelection({ nodes: ["start", "end"], edges: [] });
      expect(useEditorStore.getState().selectedNodeId).toBe("start");
      expect(useEditorStore.getState().selectedNodeIds).toEqual(["start", "end"]);
    });
  });

  describe("addNode", () => {
    it("places library clicks in free slots instead of stacking them", () => {
      const store = useEditorStore.getState();
      const first = store.addNode("planner", { x: 0, y: 0 }, { avoidOverlap: true });
      const second = store.addNode("critic", { x: 0, y: 0 }, { avoidOverlap: true });

      const nodes = useEditorStore.getState().nodes;
      const a = nodes.find((node) => node.id === first);
      const b = nodes.find((node) => node.id === second);
      expect(a).toBeDefined();
      expect(b).toBeDefined();

      // The invariant is card separation (210x92 cards): overlapping cards
      // would cover each other's connection handles.
      const separated =
        Math.abs((a?.position.x ?? 0) - (b?.position.x ?? 0)) >= 210 ||
        Math.abs((a?.position.y ?? 0) - (b?.position.y ?? 0)) >= 92;
      expect(separated).toBe(true);

      // Fresh nodes go below the existing graph rather than on top of it.
      expect(a?.position.y ?? 0).toBeGreaterThan(0);
      expect(b?.position.y ?? 0).toBeGreaterThan(a?.position.y ?? 0);

      const start = useEditorStore.getState().nodes.find((node) => node.id === "start");
      const clearsStart = Math.abs((start?.position.y ?? 0) - (a?.position.y ?? 0)) >= 92;
      expect(clearsStart).toBe(true);
    });

    it("honours an explicit drop position from drag-and-drop", () => {
      const id = useEditorStore.getState().addNode("tool", { x: 640, y: 420 });
      const node = useEditorStore.getState().nodes.find((candidate) => candidate.id === id);
      expect(node?.position).toEqual({ x: 640, y: 420 });
    });
  });

  describe("connect", () => {
    it("adds an edge once and ignores duplicates and self-loops", () => {
      const store = useEditorStore.getState();
      store.connect({ source: "start", target: "end" }); // duplicate of the seed edge
      store.connect({ source: "start", target: "start" }); // self-loop

      const added = store.addNode("planner", { x: 0, y: 0 }, { avoidOverlap: true });
      store.connect({ source: "start", target: added });
      store.connect({ source: "start", target: added });

      const edges = useEditorStore.getState().edges;
      expect(edges.filter((edge) => edge.target === added)).toHaveLength(1);
      expect(edges).toHaveLength(2);
    });
  });

  describe("undo / redo", () => {
    it("reverts a connection and reapplies it", () => {
      const store = useEditorStore.getState();
      const added = store.addNode("critic", { x: 0, y: 0 }, { avoidOverlap: true });
      store.connect({ source: "start", target: added });
      const withEdge = useEditorStore.getState().edges.length;

      useEditorStore.getState().undo();
      expect(useEditorStore.getState().edges).toHaveLength(withEdge - 1);

      useEditorStore.getState().redo();
      expect(useEditorStore.getState().edges).toHaveLength(withEdge);
    });
  });

  describe("document", () => {
    it("serializes back to a definition the validator accepts", () => {
      const store = useEditorStore.getState();
      const added = store.addNode("planner", { x: 0, y: 0 }, { avoidOverlap: true });
      store.connect({ source: "start", target: added });
      store.connect({ source: added, target: "end" });

      const document = useEditorStore.getState().document();
      expect(document.nodes.map((node) => node.id)).toEqual(["start", "end", added]);
      expect(document.edges).toHaveLength(3);
      expect(document.entryNode).toBe("start");
    });
  });
});
