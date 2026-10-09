/**
 * AI nodes: `model`, `prompt`, `planner`, `critic`, `evaluator`.
 *
 * All LLM-backed nodes share one calling convention:
 *  - the system message is the node's `systemPrompt`, else the agent's pinned
 *    instructions, else a node-type default;
 *  - the user message is the value flowing in (`{ text }` unwrapped, objects
 *    rendered as JSON) plus the node's own instructions;
 *  - structured nodes (planner/critic/evaluator) demand JSON, parse it, and get
 *    exactly one repair attempt before failing with a ValidationError. There is
 *    no natural-language guessing: an unparseable plan is a failed run step.
 *
 * Model resolution is data, never code: a node's `model` is a "provider:model"
 * ref, optionally with a separate `provider` field for shorthand model names.
 */

import { ValidationError } from "../errors/runtime-error";
import { resolveText } from "../context/expression";
import {
  inputToText,
  readNumber,
  readString,
  type NodeExecutionContext,
  type NodeExecutionResult,
  type NodeExecutor,
  type RuntimeNode,
} from "./node-executor";
import { readNumberField, readStringArray, readTextField, requireJsonObject } from "./json";
import type { LLMMessage } from "@/modules/llm/llm.types";

/** Resolves a node's model reference; returns a "provider:model" string. */
function resolveModelRef(ref: string, provider: string | undefined, node: RuntimeNode): string {
  const trimmed = ref.trim();
  if (trimmed.includes(":")) {
    return trimmed;
  }
  if (provider !== undefined && provider.trim() !== "") {
    return `${provider.trim()}:${trimmed}`;
  }
  throw new ValidationError(
    `Node "${node.label}" (model): "${trimmed}" is not a provider:model reference — set the provider field or use the provider:model form`,
    { nodeId: node.id },
  );
}

/**
 * Model source for nodes whose DSL config has no model field (planner, critic,
 * evaluator): they inherit the run's pinned agent model. An optional `model`
 * config is honored if a future DSL revision adds it.
 */
function resolveInheritedModelRef(
  context: NodeExecutionContext,
  config: Record<string, unknown>,
  node: RuntimeNode,
): string {
  const configured = typeof config["model"] === "string" ? (config["model"] as string) : undefined;
  const provider = typeof config["provider"] === "string" ? (config["provider"] as string) : undefined;
  if (configured !== undefined && configured.trim() !== "") {
    return resolveModelRef(configured, provider, node);
  }
  const agentModel = context.services.agent?.model;
  if (agentModel === undefined || agentModel === null || agentModel.trim() === "") {
    throw new ValidationError(
      `Node "${node.label}" (${node.type}) needs a model: this node type inherits the agent's model, but the run's agent has none configured`,
      { nodeId: node.id },
    );
  }
  return resolveModelRef(agentModel, undefined, node);
}

function systemPromptFor(context: NodeExecutionContext, configured: string | undefined): string | undefined {
  if (configured !== undefined && configured.trim() !== "") {
    return configured;
  }
  const instructions = context.services.agent?.instructions;
  return instructions !== undefined && instructions !== null && instructions.trim() !== ""
    ? instructions
    : undefined;
}

async function callModel(
  context: NodeExecutionContext,
  options: {
    modelRef: string;
    system: string | undefined;
    user: string;
    temperature?: number | undefined;
    maxTokens?: number | undefined;
    responseFormat?: "text" | "json";
    /** Labels the LLM call in the trace, e.g. "planner". */
    role: string;
  },
) {
  const messages: LLMMessage[] = [];
  if (options.system !== undefined) {
    messages.push({ role: "system", content: options.system });
  }
  messages.push({ role: "user", content: options.user });

  return context.services.llm.generate({
    ref: options.modelRef,
    nodeId: context.node.id,
    role: options.role,
    messages,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options.responseFormat !== undefined ? { responseFormat: options.responseFormat } : {}),
  });
}

/**
 * Asks for JSON and repairs once. `buildMessages` receives the repair hint so
 * the second attempt can restate the contract when the first response was not
 * parseable.
 */
async function callJsonModel(
  context: NodeExecutionContext,
  options: {
    modelRef: string;
    system: string | undefined;
    buildUser: (repair: boolean) => string;
    temperature?: number | undefined;
    maxTokens?: number | undefined;
    role: string;
  },
): Promise<{ record: Record<string, unknown>; content: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
  let lastContent = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await callModel(context, {
      modelRef: options.modelRef,
      system: options.system,
      user: options.buildUser(attempt > 0),
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      responseFormat: "json",
      role: options.role,
    });
    lastContent = response.content;
    try {
      return {
        record: requireJsonObject(response.content, `${context.node.label} (${options.role})`),
        content: response.content,
        usage: response.usage,
      };
    } catch (error) {
      if (attempt === 1) {
        throw error;
      }
      context.services.logger.warn("structured node output was not JSON — retrying once", {
        runId: context.run.id,
        nodeId: context.node.id,
        role: options.role,
      });
    }
  }
  throw new ValidationError(
    `${context.node.label} (${options.role}) did not return JSON after a repair attempt: ${lastContent.slice(0, 200)}`,
    { nodeId: context.node.id },
  );
}

// --- model -----------------------------------------------------------------

const modelExecutor: NodeExecutor = {
  type: "model",
  validate(config, node) {
    const ref = readString(config, "model", node, { required: true });
    const provider = readString(config, "provider", node);
    resolveModelRef(ref as string, provider, node);
    readNumber(config, "temperature", node, { min: 0, max: 2 });
    readNumber(config, "maxTokens", node, { min: 1, integer: true });
  },
  async execute(context, config): Promise<NodeExecutionResult> {
    const node = context.node;
    const ref = resolveModelRef(
      readString(config, "model", node, { required: true }) as string,
      readString(config, "provider", node),
      node,
    );
    const systemPrompt = readString(config, "systemPrompt", node);
    const response = await callModel(context, {
      modelRef: ref,
      system: systemPromptFor(context, systemPrompt),
      user: inputToText(context.input),
      temperature: readNumber(config, "temperature", node, { min: 0, max: 2 }),
      maxTokens: readNumber(config, "maxTokens", node, { min: 1, integer: true }),
      role: "model",
    });

    return {
      output: {
        text: response.content,
        provider: response.provider,
        model: response.model,
        finishReason: response.finishReason,
        usage: response.usage,
      },
      usage: response.usage,
      metadata: {
        provider: response.provider,
        model: response.model,
        latencyMs: response.latencyMs,
        finishReason: response.finishReason,
      },
    };
  },
};

// --- prompt ----------------------------------------------------------------

const promptExecutor: NodeExecutor = {
  type: "prompt",
  validate(config, node) {
    readString(config, "template", node, { required: true });
  },
  async execute(context, config): Promise<NodeExecutionResult> {
    const template = readString(config, "template", context.node, { required: true }) as string;
    // The template is resolved against run state and the incoming value, so a
    // prompt node both builds text and forwards the previous output when needed.
    return {
      output: {
        text: resolveText(template, context.scope),
        template,
      },
      state: { prompt: resolveText(template, context.scope) },
      metadata: { templateLength: template.length },
    };
  },
};

// --- planner ---------------------------------------------------------------

const PLANNER_SYSTEM =
  "You are a planning component inside a deterministic agent runtime. You output only JSON.";

const plannerExecutor: NodeExecutor = {
  type: "planner",
  validate(config, node) {
    readString(config, "instructions", node, { required: true });
    readNumber(config, "maxSteps", node, { min: 1, max: 50, integer: true });
  },
  async execute(context, config): Promise<NodeExecutionResult> {
    const node = context.node;
    const instructions = readString(config, "instructions", node, { required: true }) as string;
    const maxSteps = readNumber(config, "maxSteps", node, { min: 1, max: 50, integer: true }) ?? 8;
    const ref = resolveInheritedModelRef(context, config, node);

    const { record, usage } = await callJsonModel(context, {
      modelRef: ref,
      system: systemPromptFor(context, PLANNER_SYSTEM),
      role: "planner",
      buildUser: (repair) =>
        [
          repair === true
            ? "Your previous response was not valid JSON. Return ONLY a JSON object."
            : "",
          instructions,
          `Produce at most ${maxSteps} steps.`,
          'Respond with JSON: { "plan": string[], "summary": string }.',
          `Input:\n${inputToText(context.input)}`,
          `Current state:\n${JSON.stringify(context.services.state.variables, null, 2)}`,
        ]
          .filter((line) => line !== "")
          .join("\n\n"),
    });

    const plan = readStringArray(record, ["plan", "steps", "tasks"]).slice(0, maxSteps);
    if (plan.length === 0) {
      throw new ValidationError(`Planner "${node.label}" returned an empty plan`, {
        nodeId: node.id,
      });
    }
    const summary = readTextField(record, ["summary", "rationale", "overview"]) ?? plan.join("; ");

    return {
      output: { plan, stepCount: plan.length, summary },
      state: { plan, planStepCount: plan.length, planSummary: summary },
      usage,
      metadata: { stepCount: plan.length, model: ref },
    };
  },
};

// --- critic ----------------------------------------------------------------

const CRITIC_SYSTEM =
  "You are a critical reviewer inside a deterministic agent runtime. You output only JSON.";

const criticExecutor: NodeExecutor = {
  type: "critic",
  validate(config, node) {
    readString(config, "instructions", node, { required: true });
    readNumber(config, "threshold", node, { min: 0, max: 1 });
  },
  async execute(context, config): Promise<NodeExecutionResult> {
    const node = context.node;
    const instructions = readString(config, "instructions", node, { required: true }) as string;
    const threshold = readNumber(config, "threshold", node, { min: 0, max: 1 }) ?? 0.7;
    const ref = resolveInheritedModelRef(context, config, node);

    const { record, usage } = await callJsonModel(context, {
      modelRef: ref,
      system: systemPromptFor(context, CRITIC_SYSTEM),
      role: "critic",
      buildUser: (repair) =>
        [
          repair === true
            ? "Your previous response was not valid JSON. Return ONLY a JSON object."
            : "",
          instructions,
          'Respond with JSON: { "score": number between 0 and 1, "issues": string[], "summary": string }.',
          `Candidate output to review:\n${inputToText(context.input)}`,
          `Plan under review:\n${JSON.stringify(context.services.state.variables["plan"] ?? null)}`,
        ]
          .filter((line) => line !== "")
          .join("\n\n"),
    });

    const score = readNumberField(record, ["score", "rating", "confidence"], { min: 0, max: 1 });
    if (score === null) {
      throw new ValidationError(`Critic "${node.label}" returned no numeric score`, {
        nodeId: node.id,
      });
    }
    const issues = readStringArray(record, ["issues", "problems", "concerns"]);
    const summary =
      readTextField(record, ["summary", "critique", "feedback", "rationale"]) ??
      (issues.length > 0 ? issues.join("; ") : "No issues reported");
    const passed = score >= threshold;

    return {
      output: { score, passed, threshold, issues, critique: summary },
      state: { score, critique: summary, critiqueIssues: issues, critiquePassed: passed },
      usage,
      metadata: { score, passed, threshold, issueCount: issues.length, model: ref },
      ...(score < threshold
        ? { warnings: [`Critic score ${score.toFixed(2)} is below the ${threshold} threshold`] }
        : {}),
    };
  },
};

// --- evaluator -------------------------------------------------------------

const EVALUATOR_SYSTEM =
  "You are an evaluation component inside a deterministic agent runtime. You output only JSON.";

const evaluatorExecutor: NodeExecutor = {
  type: "evaluator",
  validate(config, node) {
    readString(config, "instructions", node, { required: true });
    readString(config, "metric", node, { required: true });
  },
  async execute(context, config): Promise<NodeExecutionResult> {
    const node = context.node;
    const instructions = readString(config, "instructions", node, { required: true }) as string;
    const metric = readString(config, "metric", node, { required: true }) as string;
    const ref = resolveInheritedModelRef(context, config, node);

    const { record, usage } = await callJsonModel(context, {
      modelRef: ref,
      system: systemPromptFor(context, EVALUATOR_SYSTEM),
      role: "evaluator",
      buildUser: (repair) =>
        [
          repair === true
            ? "Your previous response was not valid JSON. Return ONLY a JSON object."
            : "",
          instructions,
          `Score the candidate on the metric "${metric}" between 0 and 1.`,
          'Respond with JSON: { "score": number, "rationale": string }.',
          `Candidate output:\n${inputToText(context.input)}`,
        ]
          .filter((line) => line !== "")
          .join("\n\n"),
    });

    const score = readNumberField(record, ["score", "value", "rating"], { min: 0, max: 1 });
    if (score === null) {
      throw new ValidationError(`Evaluator "${node.label}" returned no numeric score`, {
        nodeId: node.id,
      });
    }
    const rationale = readTextField(record, ["rationale", "reasoning", "summary"]) ?? "";

    return {
      output: { metric, score, rationale },
      state: { score, evaluationMetric: metric, evaluationRationale: rationale },
      usage,
      metadata: { metric, score, model: ref },
    };
  },
};

export const aiExecutors: NodeExecutor[] = [
  modelExecutor,
  promptExecutor,
  plannerExecutor,
  criticExecutor,
  evaluatorExecutor,
];
