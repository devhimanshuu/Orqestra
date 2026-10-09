/**
 * Logic nodes: `condition`, `router`, `loop`, `transform`.
 *
 * These four are what make a harness a program rather than a pipeline:
 *
 *  - `condition` evaluates a safe boolean expression and picks its `true`/`false`
 *    branch (missing state evaluates to false with a warning, so a first-loop
 *    pass before a critic has written a score stops instead of crashing).
 *  - `router` picks one of several outgoing edges deterministically: an explicit
 *    `state.route` (node id or edge label) wins, otherwise the first declared
 *    edge is taken and the choice is recorded in the trace. LLM routing is a
 *    later phase — determinism first.
 *  - `loop` is the only legal cycle hub: each entry increments that loop's
 *    iteration counter and takes `body` while the budget remains, then `exit`.
 *    Exhausting `maxIterations` is a normal termination, not an error — the
 *    run-level ceiling still throws MAX_ITERATIONS_EXCEEDED if it is exceeded.
 *  - `transform` maps state through an expression, either a single value
 *    (`{{ state.draft }}`) or an object literal (`{ answer: state.draft }`).
 */

import { evaluateCondition } from "../context/condition";
import { resolvePath, resolveTemplate, resolveValue } from "../context/expression";
import { ValidationError } from "../errors/runtime-error";
import { isPlainObject, type NodeExecutionResult, type NodeExecutor } from "./node-executor";

export const conditionExecutor: NodeExecutor = {
  type: "condition",
  validate(config, node) {
    const expression = config["expression"];
    if (typeof expression !== "string" || expression.trim() === "") {
      throw new ValidationError(
        `Node "${node.label}" (condition): missing required config field "expression"`,
        { nodeId: node.id },
      );
    }
    // Fail at compile/validate time on syntax errors, not mid-run.
    try {
      evaluateCondition(expression, {
        input: null,
        previous: { nodeId: null, output: null },
        variables: {},
        steps: {},
        run: {
          id: "validate",
          harnessId: "validate",
          harnessVersionId: "validate",
          agentId: null,
          iteration: 0,
        },
        now: new Date(0).toISOString(),
      });
    } catch (error) {
      throw new ValidationError(
        `Node "${node.label}" (condition): invalid expression — ${
          error instanceof Error ? error.message : String(error)
        }`,
        { nodeId: node.id, cause: error },
      );
    }
  },
  async execute(context, config): Promise<NodeExecutionResult> {
    const expression = config["expression"] as string;
    const evaluation = evaluateCondition(expression, context.scope);
    return {
      output: {
        expression,
        result: evaluation.value,
        explanation: evaluation.explanation,
      },
      state: { condition: evaluation.value, lastCondition: evaluation.explanation },
      branch: evaluation.value ? "true" : "false",
      metadata: {
        expression,
        result: evaluation.value,
        explanation: evaluation.explanation,
        ...(evaluation.warning !== undefined ? { warning: evaluation.warning } : {}),
      },
      ...(evaluation.warning !== undefined ? { warnings: [evaluation.warning] } : {}),
    };
  },
};

export const routerExecutor: NodeExecutor = {
  type: "router",
  validate(config, node) {
    const instructions = config["instructions"];
    if (typeof instructions !== "string" || instructions.trim() === "") {
      throw new ValidationError(
        `Node "${node.label}" (router): missing required config field "instructions"`,
        { nodeId: node.id },
      );
    }
  },
  async execute(context, config): Promise<NodeExecutionResult> {
    const instructions = config["instructions"] as string;
    // Candidates come from the compiled plan (declaration order), so routing is
    // reproducible for the same harness + state.
    const candidates = context.outgoing;

    const requested = context.services.state.variables["route"] ?? context.services.state.variables["next"];
    let chosen = candidates[0] ?? null;
    let reason = "default: first declared outgoing edge";
    let unmatchedRequest = false;

    if (typeof requested === "string" && requested.trim() !== "") {
      const needle = requested.trim().toLowerCase();
      const match =
        candidates.find((candidate) => candidate.target.toLowerCase() === needle) ??
        candidates.find((candidate) => candidate.label?.toLowerCase() === needle) ??
        null;
      if (match !== null) {
        chosen = match;
        reason = `state.route matched "${requested}"`;
      } else {
        reason = `state.route "${requested}" matched no outgoing edge — used the first declared edge`;
        unmatchedRequest = true;
      }
    }

    if (chosen === null) {
      throw new ValidationError(`Router "${context.node.label}" has no outgoing edges`, {
        nodeId: context.node.id,
      });
    }

    return {
      output: {
        target: chosen.target,
        edgeId: chosen.edgeId,
        label: chosen.label,
        candidates: candidates.length,
        instructions,
        reason,
      },
      nextNodeId: chosen.target,
      state: { routeTarget: chosen.target },
      metadata: { edgeId: chosen.edgeId, target: chosen.target, candidates: candidates.length, reason },
      ...(unmatchedRequest ? { warnings: [reason] } : {}),
    };
  },
};

export const loopExecutor: NodeExecutor = {
  type: "loop",
  validate(config, node) {
    const maxIterations = config["maxIterations"];
    if (typeof maxIterations !== "number" || !Number.isInteger(maxIterations) || maxIterations < 1) {
      throw new ValidationError(
        `Node "${node.label}" (loop): "maxIterations" must be a positive integer`,
        { nodeId: node.id },
      );
    }
  },
  async execute(context, config): Promise<NodeExecutionResult> {
    const node = context.node;
    const maxIterations = config["maxIterations"] as number;
    const limits = context.services.limits;
    const alreadyEntered = limits.iterationOf(node.id);
    const nextIteration = alreadyEntered + 1;

    if (nextIteration > maxIterations) {
      // Budget exhausted: this is the loop's `exit` pass. The `exit` edge may
      // point anywhere (usually an End node), so the run continues normally.
      return {
        output: {
          iteration: alreadyEntered,
          exhausted: true,
          maxIterations,
          message: `Loop finished after ${alreadyEntered} of ${maxIterations} iterations`,
        },
        branch: "exit",
        state: { iteration: alreadyEntered, iterationsExhausted: true },
        metadata: { iteration: alreadyEntered, exhausted: true, maxIterations, branch: "exit" },
      };
    }

    // Throws MaxIterationsError when the run-level ceiling is exceeded.
    const iteration = limits.registerIteration(node.id, maxIterations);
    context.services.logger.debug("loop iteration", {
      runId: context.run.id,
      nodeId: node.id,
      iteration,
      maxIterations,
    });

    return {
      output: { iteration, exhausted: false, maxIterations },
      branch: "body",
      state: { iteration, iterationsExhausted: false },
      metadata: { iteration, exhausted: false, maxIterations, branch: "body" },
    };
  },
};

/**
 * `{ answer: state.draft, count: 3 }` → `{ answer: <state.draft>, count: 3 }`.
 * Deliberately shallow and JSON-like: harness configs must not be a programming
 * language. Returns null when the text is not an object literal.
 */
function parseObjectTemplate(
  expression: string,
): Record<string, unknown> | null {
  const trimmed = expression.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }
  const body = trimmed.slice(1, -1).trim();
  if (body === "") {
    return {};
  }

  const entries: Record<string, unknown> = {};
  let depth = 0;
  let inString: string | null = null;
  let start = 0;
  const chunks: string[] = [];

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] as string;
    if (inString !== null) {
      if (char === inString && body[index - 1] !== "\\") {
        inString = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inString = char;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]") {
      depth -= 1;
      continue;
    }
    if (char === "," && depth === 0) {
      chunks.push(body.slice(start, index));
      start = index + 1;
    }
  }
  chunks.push(body.slice(start));

  for (const chunk of chunks) {
    const separator = chunk.indexOf(":");
    if (separator === -1) {
      return null;
    }
    const rawKey = chunk.slice(0, separator).trim().replace(/^["']|["']$/g, "");
    const rawValue = chunk.slice(separator + 1).trim();
    if (rawKey === "") {
      return null;
    }
    entries[rawKey] = parseScalarOrPath(rawValue);
  }
  return entries;
}

/**
 * Literal precedence: JSON scalars → quoted string → bare state path.
 * `{ score: 0.9 }` therefore yields the number 0.9 (not the string "0.9"),
 * while `{ answer: state.draft }` yields a state reference.
 */
function parseScalarOrPath(raw: string): unknown {
  if (raw === "") {
    return "";
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    return Number(raw);
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  if (raw === "null") {
    return null;
  }
  if (/^["'][\s\S]*["']$/.test(raw)) {
    return raw.slice(1, -1);
  }
  if (/^[A-Za-z_$][A-Za-z0-9_$.\[\]]*$/.test(raw)) {
    return { __path: raw };
  }
  return raw;
}

export const transformExecutor: NodeExecutor = {
  type: "transform",
  validate(config, node) {
    const expression = config["expression"];
    if (typeof expression !== "string" || expression.trim() === "") {
      throw new ValidationError(
        `Node "${node.label}" (transform): missing required config field "expression"`,
        { nodeId: node.id },
      );
    }
  },
  async execute(context, config): Promise<NodeExecutionResult> {
    const expression = config["expression"] as string;
    const objectTemplate = parseObjectTemplate(expression);

    if (objectTemplate !== null) {
      const resolved: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(objectTemplate)) {
        if (isPlainObject(value) && typeof value["__path"] === "string") {
          resolved[key] = resolvePath(context.scope, value["__path"] as string);
        } else {
          resolved[key] = resolveValue(value, context.scope);
        }
      }
      return {
        output: resolved,
        state: { ...resolved },
        metadata: { keys: Object.keys(resolved), mode: "map" },
      };
    }

    const value = resolveTemplate(expression, context.scope);
    return {
      output: value,
      state: isPlainObject(value) ? { ...value } : { transformed: value },
      metadata: { mode: "value", expression },
    };
  },
};

/**
 * `human_approval` is refused at compile time (see executability.ts). This
 * executor exists so the registry covers every DSL node type: if a future code
 * path ever dispatches it without compiling, it fails loudly and safely instead
 * of silently approving.
 */
export const humanApprovalExecutor: NodeExecutor = {
  type: "human_approval",
  validate() {
    // Configuration is irrelevant while the node is unsupported.
  },
  async execute(context): Promise<NodeExecutionResult> {
    throw new ValidationError(
      `Node "${context.node.label}" (human_approval) is not executable in this phase — approvals arrive with durable run suspension`,
      { nodeId: context.node.id },
    );
  },
};

export const logicExecutors: NodeExecutor[] = [
  conditionExecutor,
  routerExecutor,
  loopExecutor,
  transformExecutor,
  humanApprovalExecutor,
];
