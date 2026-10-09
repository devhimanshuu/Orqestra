/**
 * Safe expression resolver.
 *
 * Harness configuration refers to runtime data with templates:
 *
 *   {{ input }}                the run input
 *   {{ previous.output }}      the output of the node that just ran
 *   {{ planner.plan }}         output of the node with id "planner"
 *   {{ state.score }}          shared run state (alias of `variables`)
 *   {{ variables.search.hits }} nested state
 *   {{ run.id }}               run metadata
 *
 * Design rules:
 *  - No `eval`, no `new Function`, no property accessors: a hand-written path
 *    walker reads own properties only.
 *  - Prototype-polluting keys are refused, so a harness can never reach
 *    `__proto__`/`constructor`.
 *  - A string that is exactly one placeholder resolves to the *raw* value
 *    (objects stay objects); mixed text is interpolated.
 *  - Missing values resolve to `undefined` and render as an empty string, so a
 *    partially-wired harness produces understandable output instead of crashing
 *    the whole run.
 */

import { ValidationError } from "../errors/runtime-error";

/** Flat data view handed to the resolver for one node execution. */
export interface ExpressionScope {
  input: unknown;
  /** Output of the node that ran immediately before the current one. */
  previous: { nodeId: string | null; output: unknown };
  /** Shared run state (`state.x` and `variables.x` are the same thing). */
  variables: Record<string, unknown>;
  /** Outputs keyed by node id — `{{ planner.plan }}` reads steps.planner.output.plan. */
  steps: Record<string, { output: unknown; type: string; label: string }>;
  run: {
    id: string;
    harnessId: string;
    harnessVersionId: string;
    agentId: string | null;
    iteration: number;
  };
  now: string;
}

/** Aliases resolved before walking a path. */
const ROOT_ALIASES: Record<string, string> = {
  state: "variables",
};

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;

type PathToken = string | number;

/** "steps.planner.hits[0].url" → ["steps", "planner", "hits", 0, "url"] */
function parsePath(path: string): PathToken[] {
  const tokens: PathToken[] = [];
  for (const rawChunk of path.split(".")) {
    const chunk = rawChunk.trim();
    if (chunk === "") {
      continue;
    }
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(chunk);
    if (match === null) {
      throw new ValidationError(`Unsupported path segment "${chunk}" in expression`);
    }
    const name = (match[1] ?? "").trim();
    if (name !== "") {
      tokens.push(name);
    }
    const indices = match[2] ?? "";
    for (const indexMatch of indices.matchAll(/\[(\d+)\]/g)) {
      tokens.push(Number(indexMatch[1]));
    }
  }
  return tokens;
}

function readSegment(current: unknown, token: PathToken): unknown {
  if (typeof token === "number") {
    return Array.isArray(current) ? current[token] : undefined;
  }
  if (token === "" || FORBIDDEN_SEGMENTS.has(token)) {
    throw new ValidationError(`Expression path "${token}" is not allowed`);
  }
  if (typeof current !== "object" || current === null) {
    return undefined;
  }
  // Own properties only: reads cannot reach a prototype.
  return Object.prototype.hasOwnProperty.call(current, token)
    ? (current as Record<string, unknown>)[token]
    : undefined;
}

/** Resolves a dotted path against the scope. Unknown paths yield `undefined`. */
export function resolvePath(scope: ExpressionScope, path: string): unknown {
  const tokens = parsePath(path);
  if (tokens.length === 0) {
    return undefined;
  }
  // Refuse forbidden segments before any lookup: a harness must never be able to
  // name `__proto__`, `prototype` or `constructor`, even as a root token.
  for (const token of tokens) {
    if (typeof token === "string" && FORBIDDEN_SEGMENTS.has(token)) {
      throw new ValidationError(`Expression path "${path}" is not allowed`);
    }
  }

  let index = 0;
  const head = tokens[0];
  if (typeof head !== "string") {
    return undefined;
  }

  const alias = ROOT_ALIASES[head] ?? head;
  let current: unknown;
  if (alias === "step" && tokens.length > 1 && typeof tokens[1] === "string") {
    // `step.<nodeId>.<path>` — explicit node reference. The node id token is
    // consumed, so the walk resumes at the path after it.
    current = scope.steps[tokens[1]];
    index = 2;
  } else {
    switch (alias) {
      case "input":
        current = scope.input;
        break;
      case "previous":
        current = scope.previous;
        break;
      case "variables":
        current = scope.variables;
        break;
      case "steps":
      case "run":
        current = scope[alias];
        break;
      case "now":
        current = scope.now;
        break;
      default: {
        // Bare node id: `{{ planner.plan }}`.
        const step = scope.steps[alias];
        if (step === undefined) {
          return undefined;
        }
        current = step.output;
        break;
      }
    }
    index = 1;
  }

  for (; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      break;
    }
    current = readSegment(current, token);
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** True when the string is a single placeholder with no surrounding text. */
function singlePlaceholder(template: string): string | null {
  const match = /^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/.exec(template);
  return match === null ? null : (match[1] ?? "");
}

/**
 * Resolves a string: a lone `{{ path }}` returns the raw value, mixed content is
 * interpolated into a string.
 */
export function resolveTemplate(template: string, scope: ExpressionScope): unknown {
  const only = singlePlaceholder(template);
  if (only !== null) {
    return resolvePath(scope, only);
  }
  return template.replace(PLACEHOLDER, (_match, path: string) =>
    stringify(resolvePath(scope, path.trim())),
  );
}

/**
 * Deep-resolves a configuration value: strings become templates, arrays and
 * plain objects are walked. Everything else passes through untouched.
 */
export function resolveValue(value: unknown, scope: ExpressionScope): unknown {
  if (typeof value === "string") {
    return resolveTemplate(value, scope);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveValue(entry, scope));
  }
  if (typeof value === "object" && value !== null) {
    const resolved: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      resolved[key] = resolveValue(entry, scope);
    }
    return resolved;
  }
  return value;
}

/** Convenience: resolves and coerces to a display/LLM-ready string. */
export function resolveText(value: unknown, scope: ExpressionScope): string {
  return stringify(resolveValue(value, scope));
}
