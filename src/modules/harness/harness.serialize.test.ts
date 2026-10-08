import { describe, expect, it } from "vitest";
import {
  assertHarnessDefinition,
  hashHarnessDefinition,
  parseHarnessDefinition,
  serializeHarnessDefinition,
} from "./harness.serialize";
import type { HarnessDefinition } from "./harness.schema";

function definition(overrides: Partial<HarnessDefinition> = {}): HarnessDefinition {
  return {
    schemaVersion: 2,
    id: "research-harness",
    version: 1,
    name: "Research harness",
    nodes: [
      { id: "start", type: "start", label: "Start", config: {}, position: { x: 0, y: 0 } },
      { id: "planner", type: "planner", label: "Planner", config: { instructions: "Plan" }, position: { x: 300, y: 0 } },
      { id: "final", type: "transform", label: "Final", config: { expression: "state.answer" }, position: { x: 600, y: 0 } },
      { id: "end", type: "end", label: "End", config: {}, position: { x: 900, y: 0 } },
    ],
    edges: [
      { id: "e1", source: "start", target: "planner" },
      { id: "e2", source: "planner", target: "final" },
      { id: "e3", source: "final", target: "end" },
    ],
    entryNode: "start",
    exitNodes: ["end"],
    ...overrides,
  };
}

describe("harness serialization", () => {
  it("produces identical canonical output regardless of node/edge order", () => {
    const a = definition();
    const reordered: HarnessDefinition = {
      ...a,
      nodes: [...a.nodes].reverse(),
    };
    expect(serializeHarnessDefinition(reordered)).toBe(serializeHarnessDefinition(a));
    expect(hashHarnessDefinition(reordered)).toBe(hashHarnessDefinition(a));
  });

  it("produces a stable sha-256 content hash", () => {
    const hash = hashHarnessDefinition(definition());
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toBe(hashHarnessDefinition(definition()));
  });

  it("changes the hash when behavior changes", () => {
    const changed = definition({
      nodes: [
        { id: "start", type: "start", label: "Start", config: {}, position: { x: 0, y: 0 } },
        { id: "planner", type: "planner", label: "Planner", config: { instructions: "Plan" }, position: { x: 300, y: 0 } },
        { id: "final", type: "transform", label: "Final", config: { expression: "state.done" }, position: { x: 600, y: 0 } },
        { id: "end", type: "end", label: "End", config: {}, position: { x: 900, y: 0 } },
      ],
    });
    expect(hashHarnessDefinition(changed)).not.toBe(hashHarnessDefinition(definition()));
  });

  it("round-trips through parse", () => {
    const parsed = parseHarnessDefinition(serializeHarnessDefinition(definition()));
    expect(parsed.ok).toBe(true);
  });

  it("reports invalid JSON clearly", () => {
    const parsed = parseHarnessDefinition("{not json");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues[0]?.message).toContain("not valid JSON");
    }
  });

  it("assertHarnessDefinition throws on invalid input", () => {
    expect(() => assertHarnessDefinition({ id: "x" })).toThrow(/Invalid harness definition/);
  });
});
