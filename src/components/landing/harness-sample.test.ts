import { describe, expect, it } from "vitest";
import { validateHarnessDefinition } from "@/modules/harness/harness.validation";
import { compileHarness } from "@/modules/runtime/compiler";
import { HARNESS_SAMPLE, HARNESS_SAMPLE_JSON } from "./harness-sample";

/**
 * The landing page puts a harness definition on the visitor's clipboard. It has
 * to be a real one: this test keeps it honest against the DSL, the graph rules
 * and the runtime compiler, so a schema change cannot silently turn the hero's
 * payload into something that no longer imports.
 */
describe("landing harness sample", () => {
  it("passes graph validation", () => {
    const result = validateHarnessDefinition(HARNESS_SAMPLE);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("compiles into an execution plan", () => {
    const compiled = compileHarness(HARNESS_SAMPLE);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) {
      return;
    }
    expect(compiled.plan.startNodeId).toBe("start");
    expect(Object.keys(compiled.plan.compiledNodes)).toHaveLength(HARNESS_SAMPLE.nodes.length);
    expect(compiled.plan.stats.estimatedLlmCalls).toBe(2);
    expect(compiled.plan.stats.estimatedToolCalls).toBe(1);
    // The declared loop is what makes the cycle legal and bounded.
    expect(compiled.plan.stats.maxIterations).toBe(3);
  });

  it("serializes to JSON that round-trips", () => {
    const parsed: unknown = JSON.parse(HARNESS_SAMPLE_JSON);
    expect(parsed).toEqual(HARNESS_SAMPLE);
  });

  it("only uses tools that are registered", () => {
    const toolNodes = HARNESS_SAMPLE.nodes.filter((node) => node.type === "tool");
    expect(toolNodes.length).toBeGreaterThan(0);
    for (const node of toolNodes) {
      expect(["calculator", "current_time", "json_transform", "http_fetch"]).toContain(
        String(node.config.toolId),
      );
    }
  });
});
