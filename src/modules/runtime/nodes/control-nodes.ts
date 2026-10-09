/**
 * Control nodes: `start` and `end`.
 *
 * `start` is the runtime's entry contract — it publishes the run input into the
 * graph and records it in run state as both `input` and the convenience key
 * `state.task`. `end` terminates successfully: its output becomes the run
 * output unless an earlier terminal branch already produced one.
 */

import type { NodeExecutionContext, NodeExecutionResult, NodeExecutor } from "./node-executor";
import { inputToText } from "./node-executor";

export const startExecutor: NodeExecutor = {
  type: "start",
  validate() {
    // No configuration.
  },
  async execute(context: NodeExecutionContext): Promise<NodeExecutionResult> {
    // The engine seeds a start node with the run input as the incoming value, so
    // the flow and run state agree by construction.
    const input = context.input;
    return {
      output: input,
      state: { input, task: inputToText(input) },
      metadata: { inputType: typeof input },
    };
  },
};

export const endExecutor: NodeExecutor = {
  type: "end",
  validate() {
    // No configuration.
  },
  async execute(context: NodeExecutionContext): Promise<NodeExecutionResult> {
    // The value flowing in is the run's answer. `{ text }` wrappers are unwrapped
    // so the API/UI always sees a plain answer when the last node was a model.
    const incoming = context.input;
    const output =
      typeof incoming === "object" &&
      incoming !== null &&
      !Array.isArray(incoming) &&
      typeof (incoming as Record<string, unknown>)["text"] === "string"
        ? (incoming as Record<string, unknown>)["text"]
        : incoming;
    return {
      output,
      metadata: { finalOutputType: typeof output },
    };
  },
};
