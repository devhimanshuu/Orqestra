import { ToolRegistry } from "./tool.registry";
import { calculatorTool } from "./tools/calculator";

export * from "./tool.types";
export { ToolRegistry } from "./tool.registry";
export { calculatorTool } from "./tools/calculator";

let defaultRegistry: ToolRegistry | null = null;

/** Process-wide registry pre-loaded with built-in tools. */
export function getToolRegistry(): ToolRegistry {
  if (defaultRegistry === null) {
    defaultRegistry = new ToolRegistry();
    defaultRegistry.register(calculatorTool);
  }
  return defaultRegistry;
}
