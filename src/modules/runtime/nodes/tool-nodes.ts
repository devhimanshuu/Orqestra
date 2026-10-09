/**
 * Tool node.
 *
 *   Tool node → permission check → registry lookup → input validation → execute
 *
 * The node itself is thin on purpose: authorization, budgets, retries and
 * events live in `RuntimeToolService`, so every tool call in the system goes
 * through exactly one guarded path.
 *
 * Input resolution: an explicit `input` object is deep-resolved against run
 * state (`{{ previous.output }}`, `{{ state.plan }}`); without one, the value
 * flowing into the node is passed to the tool. That makes both patterns work:
 *
 *   START → TOOL(calculator)                        // uses the task text
 *   START → PLANNER → TOOL(input: { expression: "{{ state.planExpression }}" })
 */

import { isPlainObject, type NodeExecutionResult, type NodeExecutor } from "./node-executor";
import { resolveValue } from "../context/expression";
import { ValidationError } from "../errors/runtime-error";

export const toolExecutor: NodeExecutor = {
  type: "tool",
  validate(config, node) {
    const toolId = config["toolId"];
    if (typeof toolId !== "string" || toolId.trim() === "") {
      throw new ValidationError(
        `Node "${node.label}" (tool): missing required config field "toolId"`,
        { nodeId: node.id },
      );
    }
    const input = config["input"];
    if (input !== undefined && (typeof input !== "object" || input === null || Array.isArray(input))) {
      throw new ValidationError(`Node "${node.label}" (tool): config field "input" must be an object`, {
        nodeId: node.id,
      });
    }
  },
  async execute(context, config): Promise<NodeExecutionResult> {
    const toolId = config["toolId"] as string;
    const configuredInput = config["input"];

    const input =
      configuredInput === undefined || configuredInput === null
        ? context.input
        : resolveValue(configuredInput, context.scope);

    const result = await context.services.tools.execute({
      toolId,
      input,
      nodeId: context.node.id,
    });

    // Tool output fields are spread outward so expressions can address them
    // directly (`{{ search.results }}`, `{{ calc.result }}`), with the raw value
    // kept under `toolResult`. The raw key is namespaced on purpose: tools are
    // free to return their own `result` field without it being shadowed.
    return {
      output: {
        ...(isPlainObject(result.output) ? result.output : {}),
        toolId,
        durationMs: result.durationMs,
        toolResult: result.output,
      },
      state: { lastToolId: toolId, lastToolOutput: result.output },
      metadata: { toolId, durationMs: result.durationMs },
    };
  },
};
