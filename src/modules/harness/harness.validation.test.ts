import { describe, expect, it } from "vitest";
import { validateHarnessDefinition } from "./harness.validation";

// Intentionally loose: these tests feed *invalid* definitions, so the helper
// must not reject them at compile time.
function linearHarness(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 2,
    id: "research-harness",
    version: 1,
    name: "Research harness",
    nodes: [
      { id: "start", type: "start", label: "Start", config: {}, position: { x: 0, y: 0 } },
      {
        id: "planner",
        type: "planner",
        label: "Planner",
        config: { instructions: "Plan" },
        position: { x: 0, y: 100 },
      },
      {
        id: "critic",
        type: "critic",
        label: "Critic",
        config: { instructions: "Critique" },
        position: { x: 0, y: 200 },
      },
      {
        id: "final",
        type: "transform",
        label: "Final",
        config: { expression: "state.answer" },
        position: { x: 0, y: 300 },
      },
      { id: "end", type: "end", label: "End", config: {}, position: { x: 0, y: 400 } },
    ],
    edges: [
      { id: "e0", source: "start", target: "planner" },
      { id: "e1", source: "planner", target: "critic" },
      { id: "e2", source: "critic", target: "final" },
      { id: "e3", source: "final", target: "end" },
    ],
    entryNode: "start",
    exitNodes: ["end"],
    ...overrides,
  };
}

function codes(result: ReturnType<typeof validateHarnessDefinition>): string[] {
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

describe("validateHarnessDefinition", () => {
  it("accepts a valid linear harness", () => {
    const result = validateHarnessDefinition(linearHarness());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.definition.entryNode).toBe("start");
      expect(result.definition.exitNodes).toEqual(["end"]);
    }
  });

  it("accepts loops and cycles (loop nodes are first-class)", () => {
    const result = validateHarnessDefinition(
      linearHarness({
        nodes: [
          { id: "start", type: "start", label: "Start", config: {}, position: { x: 0, y: 0 } },
          {
            id: "planner",
            type: "planner",
            label: "Planner",
            config: { instructions: "Plan" },
            position: { x: 0, y: 100 },
          },
          {
            id: "loop",
            type: "loop",
            label: "Retry loop",
            config: { maxIterations: 3 },
            position: { x: 0, y: 200 },
          },
          {
            id: "final",
            type: "transform",
            label: "Final",
            config: { expression: "state.answer" },
            position: { x: 0, y: 300 },
          },
          { id: "end", type: "end", label: "End", config: {}, position: { x: 0, y: 400 } },
        ],
        edges: [
          { id: "e0", source: "start", target: "planner" },
          { id: "e1", source: "planner", target: "loop" },
          { id: "e2", source: "loop", target: "loop", sourceHandle: "body" },
          { id: "e3", source: "loop", target: "final", sourceHandle: "exit" },
          { id: "e4", source: "final", target: "end" },
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects unknown node types and unknown config keys", () => {
    const unknownType = validateHarnessDefinition(
      linearHarness({
        nodes: [
          { id: "start", type: "start", label: "Start", config: {}, position: { x: 0, y: 0 } },
          { id: "a", type: "teleporter", label: "Nope", config: {}, position: { x: 0, y: 100 } },
          { id: "end", type: "end", label: "End", config: {}, position: { x: 0, y: 200 } },
        ],
        edges: [
          { id: "e0", source: "start", target: "a" },
          { id: "e1", source: "a", target: "end" },
        ],
        entryNode: "start",
        exitNodes: ["end"],
      }),
    );
    expect(unknownType.ok).toBe(false);
    expect(codes(unknownType)).toContain("INVALID_SCHEMA");

    const unknownConfigKey = validateHarnessDefinition(
      linearHarness({
        nodes: [
          { id: "start", type: "start", label: "Start", config: {}, position: { x: 0, y: 0 } },
          {
            id: "planner",
            type: "planner",
            label: "Planner",
            config: { instructions: "x", nope: 1 },
            position: { x: 0, y: 100 },
          },
          { id: "end", type: "end", label: "End", config: {}, position: { x: 0, y: 200 } },
        ],
        edges: [
          { id: "e0", source: "start", target: "planner" },
          { id: "e1", source: "planner", target: "end" },
        ],
        entryNode: "start",
        exitNodes: ["end"],
      }),
    );
    expect(unknownConfigKey.ok).toBe(false);
  });

  it("rejects an entry node that is not the start node", () => {
    const result = validateHarnessDefinition(linearHarness({ entryNode: "planner" }));
    expect(codes(result)).toContain("ENTRY_NOT_START");
  });

  it("rejects a missing or duplicated exit node", () => {
    expect(codes(validateHarnessDefinition(linearHarness({ exitNodes: ["ghost"] })))).toContain(
      "MISSING_EXIT_NODE",
    );
    expect(
      codes(validateHarnessDefinition(linearHarness({ exitNodes: ["end", "end"] }))),
    ).toContain("DUPLICATE_EXIT_NODE");
  });

  it("rejects duplicate node and edge ids", () => {
    const duplicateNodes = validateHarnessDefinition(
      linearHarness({
        nodes: [
          { id: "start", type: "start", label: "Start", config: {}, position: { x: 0, y: 0 } },
          {
            id: "planner",
            type: "planner",
            label: "Planner",
            config: { instructions: "x" },
            position: { x: 0, y: 100 },
          },
          {
            id: "planner",
            type: "transform",
            label: "Dup",
            config: { expression: "y" },
            position: { x: 0, y: 200 },
          },
          { id: "end", type: "end", label: "End", config: {}, position: { x: 0, y: 300 } },
        ],
        edges: [
          { id: "e0", source: "start", target: "planner" },
          { id: "e1", source: "planner", target: "end" },
        ],
        entryNode: "start",
        exitNodes: ["end"],
      }),
    );
    expect(codes(duplicateNodes)).toContain("DUPLICATE_NODE_ID");

    const duplicateEdges = validateHarnessDefinition(
      linearHarness({
        edges: [
          { id: "e0", source: "start", target: "planner" },
          { id: "e1", source: "planner", target: "critic" },
          { id: "e1", source: "planner", target: "critic" },
          { id: "e2", source: "critic", target: "final" },
          { id: "e3", source: "final", target: "end" },
        ],
      }),
    );
    expect(codes(duplicateEdges)).toContain("DUPLICATE_EDGE_ID");
  });

  it("rejects edges referencing unknown nodes", () => {
    const result = validateHarnessDefinition(
      linearHarness({
        nodes: [
          { id: "start", type: "start", label: "Start", config: {}, position: { x: 0, y: 0 } },
          {
            id: "planner",
            type: "planner",
            label: "Planner",
            config: { instructions: "x" },
            position: { x: 0, y: 100 },
          },
          { id: "end", type: "end", label: "End", config: {}, position: { x: 0, y: 200 } },
        ],
        edges: [
          { id: "e0", source: "start", target: "planner" },
          { id: "e1", source: "planner", target: "ghost" },
        ],
      }),
    );
    expect(codes(result)).toContain("EDGE_UNKNOWN_TARGET");
  });

  it("rejects unreachable nodes", () => {
    const result = validateHarnessDefinition(
      linearHarness({
        nodes: [
          { id: "start", type: "start", label: "Start", config: {}, position: { x: 0, y: 0 } },
          {
            id: "planner",
            type: "planner",
            label: "Planner",
            config: { instructions: "x" },
            position: { x: 0, y: 100 },
          },
          {
            id: "final",
            type: "transform",
            label: "Final",
            config: { expression: "y" },
            position: { x: 0, y: 200 },
          },
          {
            id: "orphan",
            type: "critic",
            label: "Orphan",
            config: { instructions: "z" },
            position: { x: 0, y: 300 },
          },
          { id: "end", type: "end", label: "End", config: {}, position: { x: 0, y: 400 } },
        ],
        edges: [
          { id: "e0", source: "start", target: "planner" },
          { id: "e1", source: "planner", target: "final" },
          { id: "e2", source: "final", target: "end" },
        ],
      }),
    );
    expect(codes(result)).toContain("UNREACHABLE_NODE");
  });

  it("rejects dead-end nodes that are not exit nodes", () => {
    const result = validateHarnessDefinition(
      linearHarness({
        edges: [
          { id: "e0", source: "start", target: "planner" },
          { id: "e1", source: "planner", target: "critic" },
          { id: "e2", source: "planner", target: "final" },
          { id: "e3", source: "final", target: "end" },
        ],
      }),
    );
    // "critic" is reachable but leads nowhere and is not an exit node.
    expect(codes(result)).toContain("DEAD_END_NODE");
    expect(codes(result)).not.toContain("UNREACHABLE_NODE");
  });

  it("rejects exit nodes that are not end nodes", () => {
    const result = validateHarnessDefinition(
      linearHarness({
        exitNodes: ["planner", "end"],
      }),
    );
    expect(codes(result)).toContain("EXIT_NOT_END");
  });

  it("rejects structurally invalid input", () => {
    expect(validateHarnessDefinition(null).ok).toBe(false);
    expect(validateHarnessDefinition({ nodes: [] }).ok).toBe(false);
    expect(validateHarnessDefinition("not-json").ok).toBe(false);
  });
});