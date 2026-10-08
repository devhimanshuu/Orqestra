import { describe, expect, it } from "vitest";
import { compileHarness } from "./compiler";

const validHarness = {
  schemaVersion: 2,
  id: "research-harness",
  version: 2,
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
      id: "search",
      type: "tool",
      label: "Search",
      config: { toolId: "calculator" },
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
    { id: "e1", source: "planner", target: "search" },
    { id: "e2", source: "search", target: "final" },
    { id: "e3", source: "final", target: "end" },
  ],
  entryNode: "start",
  exitNodes: ["end"],
};

describe("compileHarness", () => {
  it("compiles a validated definition into an execution plan", () => {
    const result = compileHarness(validHarness);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.plan.entryNode).toBe("start");
    expect(result.plan.exitNodes).toEqual(["end"]);
    expect(result.plan.nodes).toHaveLength(5);
    expect(result.plan.adjacency).toEqual({
      start: ["planner"],
      planner: ["search"],
      search: ["final"],
      final: ["end"],
      end: [],
    });
    expect(result.plan.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses to compile an invalid harness and returns the issues", () => {
    const result = compileHarness({ ...validHarness, entryNode: "planner" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toContain("ENTRY_NOT_START");
    }
  });

  it("is deterministic for the same definition", () => {
    const first = compileHarness(validHarness);
    const second = compileHarness({ ...validHarness });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.plan.contentHash).toBe(second.plan.contentHash);
    }
  });
});