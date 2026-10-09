import { z } from "zod";
import { ToolError, type AgentTool, type ToolResult } from "../tool.types";

/**
 * JSON transform — deterministic, declarative reshaping of structured data.
 *
 * Deliberately not a templating/JQ language: a small fixed set of operations
 * runs in order over the input value, so a harness can turn a planner's output
 * into a tool's expected input without any code execution anywhere.
 *
 *   { source: "{{ previous.output }}",
 *     operations: [{ op: "path", key: "plan" }, { op: "limit", limit: 3 }] }
 */

const operationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("pick"), keys: z.array(z.string()).min(1).max(50) }),
  z.object({ op: z.literal("omit"), keys: z.array(z.string()).min(1).max(50) }),
  z.object({ op: z.literal("path"), key: z.string().min(1).max(200) }),
  z.object({
    op: z.literal("sortBy"),
    key: z.string().min(1).max(200).optional(),
    direction: z.enum(["asc", "desc"]).optional(),
  }),
  z.object({ op: z.literal("limit"), limit: z.number().int().min(0).max(1_000) }),
  z.object({ op: z.literal("count") }),
  z.object({ op: z.literal("join"), separator: z.string().max(10).optional() }),
]);

const inputSchema = z.object({
  source: z.unknown(),
  operations: z.array(operationSchema).max(20).optional(),
});

type Input = z.infer<typeof inputSchema>;
type Output = { value: unknown; operations: string[] };

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (segment === "") {
      continue;
    }
    const index = Number(segment);
    if (Array.isArray(current) && Number.isInteger(index)) {
      current = current[index];
    } else if (typeof current === "object" && current !== null && !Array.isArray(current)) {
      const record = current as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(record, segment)) {
        return undefined;
      }
      current = record[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Stable comparator: numbers numerically, everything else by string form. */
function compare(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return String(left).localeCompare(String(right));
}

function applyOperation(
  value: unknown,
  operation: z.infer<typeof operationSchema>,
): unknown {
  switch (operation.op) {
    case "pick": {
      const record = asRecord(value);
      const picked: Record<string, unknown> = {};
      for (const key of operation.keys) {
        if (Object.prototype.hasOwnProperty.call(record, key)) {
          picked[key] = record[key];
        }
      }
      return picked;
    }
    case "omit": {
      const record = asRecord(value);
      const kept: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(record)) {
        if (!operation.keys.includes(key)) {
          kept[key] = entry;
        }
      }
      return kept;
    }
    case "path": {
      const resolved = readPath(value, operation.key);
      if (resolved === undefined) {
        throw new ToolError(
          "EXECUTION_FAILED",
          "json_transform",
          `Path "${operation.key}" does not exist in the input`,
        );
      }
      return resolved;
    }
    case "sortBy": {
      if (!Array.isArray(value)) {
        throw new ToolError("EXECUTION_FAILED", "json_transform", "sortBy requires an array");
      }
      const direction = operation.direction ?? "asc";
      const sorted = [...value].sort((left, right) => {
        const leftValue = operation.key === undefined ? left : readPath(left, operation.key);
        const rightValue = operation.key === undefined ? right : readPath(right, operation.key);
        const order = compare(leftValue, rightValue);
        return direction === "asc" ? order : -order;
      });
      return sorted;
    }
    case "limit": {
      if (!Array.isArray(value)) {
        throw new ToolError("EXECUTION_FAILED", "json_transform", "limit requires an array");
      }
      return value.slice(0, operation.limit);
    }
    case "count": {
      if (Array.isArray(value)) {
        return value.length;
      }
      if (typeof value === "object" && value !== null) {
        return Object.keys(value).length;
      }
      return typeof value === "string" ? value.length : 1;
    }
    case "join": {
      if (!Array.isArray(value)) {
        throw new ToolError("EXECUTION_FAILED", "json_transform", "join requires an array");
      }
      return value.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).join(
        operation.separator ?? "\n",
      );
    }
    default:
      throw new ToolError("EXECUTION_FAILED", "json_transform", "Unsupported operation");
  }
}

export const jsonTransformTool: AgentTool<Input, Output> = {
  id: "json_transform",
  name: "JSON transform",
  description:
    "Reshapes structured data with declarative operations (pick, omit, path, sortBy, limit, count, join).",
  version: 1,
  inputSchema,
  async execute(input: Input): Promise<ToolResult<Output>> {
    const startedAt = performance.now();
    let value: unknown = input.source;
    const applied: string[] = [];

    for (const operation of input.operations ?? []) {
      value = applyOperation(value, operation);
      applied.push(operation.op);
    }

    return {
      output: { value, operations: applied },
      durationMs: Math.round(performance.now() - startedAt),
    };
  },
};
