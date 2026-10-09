/**
 * Condition / predicate evaluator for `condition` and `loop` nodes.
 *
 * A hand-written recursive-descent parser over a deliberately tiny grammar:
 *
 *   state.score >= 0.8
 *   variables.hasResults == true
 *   previous.output.done
 *   steps.search.hits.length > 0 && !variables.exhausted
 *   (state.score >= 0.8) || state.override
 *
 * Supported: numbers, strings, true/false/null, dotted paths with `[n]` indices,
 * `== != >= <= > <`, `&& || !`, parentheses.
 *
 * Deliberately NOT supported: function calls, arithmetic, assignment, `eval`,
 * `new Function`. A harness can never execute code — only read state.
 *
 * Evaluation never throws on missing data: an undefined path is falsy and
 * records a warning, so `state.score >= 0.8` on the first loop pass (before the
 * critic has written a score) stops the loop instead of killing the run. Type
 * mismatches (comparing a string to a number) also evaluate to false *and*
 * report a warning, which the trace surfaces to the user.
 */

import { ValidationError } from "../errors/runtime-error";
import { resolvePath, type ExpressionScope } from "./expression";

export interface ConditionEvaluation {
  value: boolean;
  /** Human-readable reasoning, persisted with the step for the run UI. */
  explanation: string;
  /** Set when the expression could not be compared meaningfully. */
  warning?: string;
}

type Token =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" }
  | { kind: "path"; value: string }
  | { kind: "operator"; value: string };

const OPERATORS = ["||", "&&", "==", "!=", ">=", "<=", ">", "<", "!", "(", ")"];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index] as string;

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      const end = source.indexOf(char, index + 1);
      if (end === -1) {
        throw new ValidationError(`Unterminated string literal in condition: ${source}`);
      }
      tokens.push({ kind: "string", value: source.slice(index + 1, end) });
      index = end + 1;
      continue;
    }

    if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(source[index + 1] ?? ""))) {
      const match = /^[0-9]*\.?[0-9]+/.exec(source.slice(index));
      if (match === null) {
        throw new ValidationError(`Invalid number in condition at position ${index}`);
      }
      tokens.push({ kind: "number", value: Number(match[0]) });
      index += match[0].length;
      continue;
    }

    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, index));
    if (operator !== undefined) {
      tokens.push({ kind: "operator", value: operator });
      index += operator.length;
      continue;
    }

    const pathMatch = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z0-9_$]+|\[\d+\])*/.exec(
      source.slice(index),
    );
    if (pathMatch === null) {
      throw new ValidationError(`Unexpected character "${char}" in condition: ${source}`);
    }
    const literal = pathMatch[0];
    if (literal === "true" || literal === "false") {
      tokens.push({ kind: "boolean", value: literal === "true" });
    } else if (literal === "null") {
      tokens.push({ kind: "null" });
    } else {
      tokens.push({ kind: "path", value: literal });
    }
    index += literal.length;
  }

  return tokens;
}

type Operand = unknown;

function isTruthy(value: Operand): boolean {
  if (value === undefined || value === null || value === false) {
    return false;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && value !== 0;
  }
  if (typeof value === "string") {
    return value !== "";
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return true;
}

function canonical(value: Operand): string {
  if (value === undefined || value === null) {
    return "null";
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return JSON.stringify(value) ?? String(value);
}

function equals(left: Operand, right: Operand): boolean {
  if (left === undefined || left === null) {
    return right === undefined || right === null;
  }
  if (right === undefined || right === null) {
    return false;
  }
  if (typeof left === "object" || typeof right === "object") {
    return canonical(left) === canonical(right);
  }
  return left === right;
}

function display(value: Operand): string {
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "object" && value !== null) {
    const text = canonical(value);
    return text.length > 60 ? `${text.slice(0, 57)}…` : text;
  }
  return String(value);
}

/**
 * Evaluates a condition expression against the expression scope.
 * Throws `ValidationError` only for syntax errors — never for missing data.
 */
export function evaluateCondition(expression: string, scope: ExpressionScope): ConditionEvaluation {
  const tokens = tokenize(expression);
  if (tokens.length === 0) {
    throw new ValidationError("Condition expression is empty");
  }

  let position = 0;
  const warnings: string[] = [];

  const peek = (): Token | undefined => tokens[position];
  const consumeOperator = (value: string): boolean => {
    const token = peek();
    if (token !== undefined && token.kind === "operator" && token.value === value) {
      position += 1;
      return true;
    }
    return false;
  };

  function parseOr(): Operand {
    let left = parseAnd();
    while (consumeOperator("||")) {
      const right = parseAnd();
      left = isTruthy(left) || isTruthy(right);
    }
    return left;
  }

  function parseAnd(): Operand {
    let left = parseComparison();
    while (consumeOperator("&&")) {
      const right = parseComparison();
      left = isTruthy(left) && isTruthy(right);
    }
    return left;
  }

  function parseComparison(): Operand {
    const left = parseUnary();
    const token = peek();
    if (token === undefined || token.kind !== "operator") {
      return left;
    }
    const operator = token.value;
    if (!["==", "!=", ">=", "<=", ">", "<"].includes(operator)) {
      return left;
    }
    position += 1;
    const right = parseUnary();
    return compare(operator, left, right);
  }

  function compare(operator: string, left: Operand, right: Operand): boolean {
    if (operator === "==") {
      return equals(left, right);
    }
    if (operator === "!=") {
      return !equals(left, right);
    }

    const bothNumbers = typeof left === "number" && typeof right === "number";
    const bothStrings = typeof left === "string" && typeof right === "string";
    const missing = left === undefined || right === undefined || left === null || right === null;

    if (!bothNumbers && !bothStrings) {
      warnings.push(
        `Cannot compare ${display(left)} ${operator} ${display(right)} (${missing ? "missing value" : "type mismatch"}) — treated as false`,
      );
      return false;
    }

    if (bothNumbers) {
      const l = left as number;
      const r = right as number;
      switch (operator) {
        case ">=":
          return l >= r;
        case "<=":
          return l <= r;
        case ">":
          return l > r;
        default:
          return l < r;
      }
    }

    const l = left as string;
    const r = right as string;
    switch (operator) {
      case ">=":
        return l >= r;
      case "<=":
        return l <= r;
      case ">":
        return l > r;
      default:
        return l < r;
    }
  }

  function parseUnary(): Operand {
    if (consumeOperator("!")) {
      return !isTruthy(parseUnary());
    }
    return parsePrimary();
  }

  function parsePrimary(): Operand {
    const token = peek();
    if (token === undefined) {
      throw new ValidationError(`Unexpected end of condition: ${expression}`);
    }
    if (token.kind === "operator" && token.value === "(") {
      position += 1;
      const value = parseOr();
      if (!consumeOperator(")")) {
        throw new ValidationError(`Missing closing parenthesis in condition: ${expression}`);
      }
      return value;
    }
    position += 1;
    switch (token.kind) {
      case "number":
      case "string":
      case "boolean":
        return token.value;
      case "null":
        return null;
      case "path":
        return resolvePath(scope, token.value);
      default:
        throw new ValidationError(`Unexpected token "${token.value}" in condition: ${expression}`);
    }
  }

  const result = parseOr();
  if (position !== tokens.length) {
    throw new ValidationError(`Unexpected trailing input in condition: ${expression}`);
  }

  const value = isTruthy(result);
  return {
    value,
    explanation: `${expression} → ${value ? "true" : "false"}`,
    ...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}),
  };
}
