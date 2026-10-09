import { ToolRegistry } from "./tool.registry";
import { calculatorTool } from "./tools/calculator";
import { currentTimeTool } from "./tools/current-time";
import { httpFetchTool } from "./tools/http-fetch";
import { jsonTransformTool } from "./tools/json-transform";

export * from "./tool.types";
export { ToolRegistry } from "./tool.registry";
export { calculatorTool } from "./tools/calculator";
export { currentTimeTool } from "./tools/current-time";
export { httpFetchTool } from "./tools/http-fetch";
export { jsonTransformTool } from "./tools/json-transform";

let defaultRegistry: ToolRegistry | null = null;

/**
 * Process-wide registry pre-loaded with built-in tools.
 *
 * Tools are code-level plugins in this phase: a harness node references a tool
 * by id, and only ids registered here can execute. No shell, no filesystem, no
 * arbitrary code — `tool-service.ts` enforces the permission policy on top.
 */
export function getToolRegistry(): ToolRegistry {
  if (defaultRegistry === null) {
    const registry = new ToolRegistry();
    // Registration order is the order the tool picker shows.
    registry.register(calculatorTool);
    registry.register(jsonTransformTool);
    registry.register(currentTimeTool);
    registry.register(httpFetchTool);
    defaultRegistry = registry;
  }
  return defaultRegistry;
}
