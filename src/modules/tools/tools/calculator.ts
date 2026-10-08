import { z } from "zod";
import type { AgentTool, ToolResult } from "../tool.types";

/**
 * Example tool: a safe arithmetic calculator.
 *
 * Demonstrates the Phase 0 tool contract end-to-end: Zod input schema,
 * deterministic execution, structured output, no eval()/no dependencies.
 */

const inputSchema = z.object({
  expression: z.string().min(1).max(500),
});

type Input = z.infer<typeof inputSchema>;
type Output = { result: number; expression: string };

type Token =
  | { kind: "number"; value: number }
  | { kind: "op"; value: "+" | "-" | "*" | "/" }
  | { kind: "lparen" }
  | { kind: "rparen" };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === " ") {
      index += 1;
      continue;
    }
    if (char === "(") {
      tokens.push({ kind: "lparen" });
      index += 1;
      continue;
    }
    if (char === ")") {
      tokens.push({ kind: "rparen" });
      index += 1;
      continue;
    }
    if (char === "+" || char === "-" || char === "*" || char === "/") {
      tokens.push({ kind: "op", value: char });
      index += 1;
      continue;
    }
    if (/[0-9.]/.test(char)) {
      const match = /^[0-9]*\.?[0-9]+/.exec(source.slice(index));
      if (match === null) {
        throw new Error(`Invalid number at position ${index}`);
      }
      tokens.push({ kind: "number", value: Number(match[0]) });
      index += match[0].length;
      continue;
    }
    throw new Error(`Unexpected character "${char}" at position ${index}`);
  }
  return tokens;
}

/** Recursive-descent parser/evaluator: numbers, + - * /, parentheses, unary minus. */
function evaluate(source: string): number {
  const tokens = tokenize(source);
  let position = 0;

  const peek = (): Token | undefined => tokens[position];
  const consumeOp = (...ops: string[]): "+" | "-" | "*" | "/" | null => {
    const token = peek();
    if (token !== undefined && token.kind === "op" && ops.includes(token.value)) {
      position += 1;
      return token.value;
    }
    return null;
  };

  function parseExpression(): number {
    let left = parseTerm();
    for (;;) {
      const op = consumeOp("+", "-");
      if (op === null) {
        return left;
      }
      const right = parseTerm();
      left = op === "+" ? left + right : left - right;
    }
  }

  function parseTerm(): number {
    let left = parseFactor();
    for (;;) {
      const op = consumeOp("*", "/");
      if (op === null) {
        return left;
      }
      const right = parseFactor();
      if (op === "*") {
        left = left * right;
      } else {
        if (right === 0) {
          throw new Error("Division by zero");
        }
        left = left / right;
      }
    }
  }

  function parseFactor(): number {
    const op = consumeOp("-");
    if (op === "-") {
      return -parseFactor();
    }
    const token = peek();
    if (token === undefined) {
      throw new Error("Unexpected end of expression");
    }
    if (token.kind === "number") {
      position += 1;
      return token.value;
    }
    if (token.kind === "lparen") {
      position += 1;
      const value = parseExpression();
      const closing = peek();
      if (closing === undefined || closing.kind !== "rparen") {
        throw new Error("Missing closing parenthesis");
      }
      position += 1;
      return value;
    }
    throw new Error(`Unexpected token at position ${position}`);
  }

  const result = parseExpression();
  if (position !== tokens.length) {
    throw new Error(`Unexpected trailing input at position ${position}`);
  }
  if (!Number.isFinite(result)) {
    throw new Error("Result is not a finite number");
  }
  return result;
}

export const calculatorTool: AgentTool<Input, Output> = {
  id: "calculator",
  name: "Calculator",
  description: "Evaluates an arithmetic expression (numbers, + - * /, parentheses).",
  version: 1,
  inputSchema,
  async execute(input: Input): Promise<ToolResult<Output>> {
    const startedAt = performance.now();
    const result = evaluate(input.expression);
    return {
      output: { result, expression: input.expression },
      durationMs: Math.round(performance.now() - startedAt),
    };
  },
};
