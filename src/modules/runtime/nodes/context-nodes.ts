/**
 * Context nodes: `context` and `memory`.
 *
 * `context` assembles one piece of prompt context from an explicit source —
 * agent instructions, the run input, accumulated state, or a static value — and
 * exposes it as `{ text }`. Prompt/model nodes downstream read it through the
 * incoming value, so context assembly never depends on hidden globals.
 *
 * `memory` appends to an in-process, run-scoped store (Phase 2 memory is
 * deliberately disposable: nothing is persisted across runs). Cross-run scopes
 * are refused at compile time by `executability.ts`, not here.
 */

import { ValidationError } from "../errors/runtime-error";
import { toReferenceKey, type NodeExecutionResult, type NodeExecutor } from "./node-executor";

const CONTEXT_SOURCES = ["agent_instructions", "run_input", "state", "static"] as const;

/** Characters per token used for the (approximate) `maxTokens` budget. */
const CHARS_PER_TOKEN = 4;

function truncate(text: string, maxTokens: number | undefined): { text: string; truncated: boolean } {
  if (maxTokens === undefined) {
    return { text, truncated: false };
  }
  const budget = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= budget) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, Math.max(0, budget - 1))}…`, truncated: true };
}

export const contextExecutor: NodeExecutor = {
  type: "context",
  validate(config, node) {
    const source = config["source"];
    if (typeof source !== "string" || !CONTEXT_SOURCES.includes(source as (typeof CONTEXT_SOURCES)[number])) {
      throw new ValidationError(
        `Node "${node.label}" (context): "source" must be one of ${CONTEXT_SOURCES.join(", ")}`,
        { nodeId: node.id },
      );
    }
    if (source === "static" && (typeof config["value"] !== "string" || config["value"] === "")) {
      throw new ValidationError(
        `Node "${node.label}" (context): a static source requires a non-empty "value"`,
        { nodeId: node.id },
      );
    }
  },
  async execute(context, config): Promise<NodeExecutionResult> {
    const node = context.node;
    const source = config["source"] as (typeof CONTEXT_SOURCES)[number];
    const maxTokens = typeof config["maxTokens"] === "number" ? config["maxTokens"] : undefined;
    const state = context.services.state;

    if (source === "static" && typeof config["value"] !== "string") {
      // Compile-time validation catches this first; the executor still refuses
      // rather than assembling an empty context from a malformed config.
      throw new ValidationError(
        `Node "${node.label}" (context): a static source requires a non-empty "value"`,
        { nodeId: node.id },
      );
    }

    let raw: string;
    switch (source) {
      case "agent_instructions":
        raw = context.services.agent?.instructions ?? "";
        break;
      case "run_input":
        raw =
          typeof state.input === "string" ? state.input : JSON.stringify(state.input, null, 2);
        break;
      case "state":
        raw = JSON.stringify(state.variables, null, 2);
        break;
      case "static":
        raw = config["value"] as string;
        break;
      default:
        throw new ValidationError(`Unsupported context source "${String(source)}"`, {
          nodeId: node.id,
        });
    }

    const { text, truncated } = truncate(raw, maxTokens);
    return {
      output: {
        source,
        text,
        truncated,
        characters: text.length,
      },
      state: { context: text, contextSource: source },
      metadata: { source, truncated, characters: text.length, maxTokens: maxTokens ?? null },
      ...(raw === "" ? { warnings: [`Context source "${source}" produced no text`] } : {}),
    };
  },
};

const MEMORY_SCOPES = ["step", "run"] as const;

export const memoryExecutor: NodeExecutor = {
  type: "memory",
  validate(config, node) {
    const scope = config["scope"];
    if (typeof scope !== "string" || !["step", "run", "session", "persistent"].includes(scope)) {
      throw new ValidationError(
        `Node "${node.label}" (memory): "scope" must be one of step, run, session, persistent`,
        { nodeId: node.id },
      );
    }
    if (typeof config["maxItems"] === "number" && config["maxItems"] < 1) {
      throw new ValidationError(`Node "${node.label}" (memory): "maxItems" must be at least 1`, {
        nodeId: node.id,
      });
    }
  },
  async execute(context, config): Promise<NodeExecutionResult> {
    const node = context.node;
    const configured = config["scope"] as string;
    // Only step/run memory is implemented in Phase 2: session and persistent
    // scopes validate (so saved harnesses stay forward-compatible) but fall back
    // to run-scoped memory, and the step says so instead of lying about it.
    const implemented = (MEMORY_SCOPES as readonly string[]).includes(configured);
    const scope = configured === "step" ? "step" : MEMORY_SCOPES[1];
    const maxItems = typeof config["maxItems"] === "number" ? config["maxItems"] : 20;
    const memory = context.services.memory;
    // `step` memory is isolated per node visit; `run` memory is shared across the
    // whole run but reset once the run ends.
    const key = scope === "step" ? `step:${node.id}:${context.run.iteration}` : "run";

    const entry = {
      at: context.services.now().toISOString(),
      nodeId: node.id,
      value: context.input,
    };
    const items = memory.append(key, entry, maxItems);

    return {
      output: {
        scope,
        size: items.length,
        latest: entry.value,
        items: items.map((item) => item.value),
      },
      state: {
        memory: items.map((item) => item.value),
        memorySize: items.length,
        [`memory_${toReferenceKey(node.label)}`]: items.map((item) => item.value),
      },
      metadata: { scope, configuredScope: configured, size: items.length, maxItems },
      ...(implemented
        ? {}
        : {
            warnings: [
              `Node "${node.label}" (memory): scope "${configured}" is not implemented yet — using run-scoped memory`,
            ],
          }),
    };
  },
};
