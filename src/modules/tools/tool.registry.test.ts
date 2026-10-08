import { describe, expect, it } from "vitest";
import { createLogger } from "@/lib/logging/logger";
import { ToolRegistry } from "./tool.registry";
import { ToolError, type ToolContext } from "./tool.types";
import { calculatorTool } from "./tools/calculator";
import { getToolRegistry } from "./index";

const context: ToolContext = {
  logger: createLogger({ test: true }),
  metadata: { runId: "run-1", nodeId: "node-1" },
};

describe("ToolRegistry", () => {
  it("registers and lists built-in tools", () => {
    const registry = new ToolRegistry();
    registry.register(calculatorTool);
    const tools = registry.list();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ id: "calculator", version: 1 });
    expect(registry.has("calculator")).toBe(true);
  });

  it("rejects duplicate tool ids", () => {
    const registry = new ToolRegistry();
    registry.register(calculatorTool);
    expect(() => registry.register(calculatorTool)).toThrow(ToolError);
  });

  it("validates input against the tool schema", async () => {
    const registry = new ToolRegistry();
    registry.register(calculatorTool);
    await expect(registry.execute("calculator", { nope: 1 }, context)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("reports unknown tools", async () => {
    const registry = new ToolRegistry();
    await expect(registry.execute("ghost", {}, context)).rejects.toMatchObject({
      code: "TOOL_NOT_FOUND",
    });
  });

  it("normalizes tool failures into ToolError", async () => {
    const registry = new ToolRegistry();
    registry.register(calculatorTool);
    await expect(
      registry.execute("calculator", { expression: "1/0" }, context),
    ).rejects.toMatchObject({ code: "EXECUTION_FAILED" });
  });

  it("exposes the shared default registry", () => {
    expect(getToolRegistry().has("calculator")).toBe(true);
  });
});

describe("calculator tool", () => {
  it("evaluates arithmetic with precedence and parentheses", async () => {
    const registry = new ToolRegistry();
    registry.register(calculatorTool);
    const result = await registry.execute("calculator", { expression: "2 + 3 * (4 - 1)" }, context);
    expect(result.output).toMatchObject({ result: 11 });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("handles unary minus and division", async () => {
    const registry = new ToolRegistry();
    registry.register(calculatorTool);
    const result = await registry.execute("calculator", { expression: "-8 / 2" }, context);
    expect(result.output).toMatchObject({ result: -4 });
  });

  it("never evaluates arbitrary code", async () => {
    const registry = new ToolRegistry();
    registry.register(calculatorTool);
    // Only arithmetic reaches the evaluator: identifiers/statements fail parsing.
    await expect(
      registry.execute("calculator", { expression: "process.exit(1)" }, context),
    ).rejects.toMatchObject({ code: "EXECUTION_FAILED" });
    await expect(
      registry.execute("calculator", { expression: "require('fs')" }, context),
    ).rejects.toMatchObject({ code: "EXECUTION_FAILED" });
  });
});
