import type { z } from "zod";
import type { AgentTool, ToolContext, ToolInfo, ToolResult } from "./tool.types";
import { ToolError } from "./tool.types";

/**
 * Tool registry — the runtime's only door to tools.
 *
 * Registration erases each tool's generic signature into a common shape while
 * keeping schema validation in front of every execution, so heterogeneous
 * tools can live in one collection without `any`.
 */

type ErasedTool = {
  info: ToolInfo;
  inputSchema: z.ZodType;
  execute: (input: unknown, context: ToolContext) => Promise<ToolResult>;
};

function erase<TIn, TOut>(tool: AgentTool<TIn, TOut>): ErasedTool {
  return {
    info: {
      id: tool.id,
      name: tool.name,
      description: tool.description,
      version: tool.version,
    },
    inputSchema: tool.inputSchema,
    execute: (input, context) => tool.execute(tool.inputSchema.parse(input) as TIn, context),
  };
}

export class ToolRegistry {
  private readonly tools = new Map<string, ErasedTool>();

  register<TIn, TOut>(tool: AgentTool<TIn, TOut>): void {
    if (this.tools.has(tool.id)) {
      throw new ToolError("EXECUTION_FAILED", tool.id, `Tool "${tool.id}" is already registered`);
    }
    this.tools.set(tool.id, erase(tool));
  }

  has(id: string): boolean {
    return this.tools.has(id);
  }

  get(id: string): ToolInfo | null {
    return this.tools.get(id)?.info ?? null;
  }

  list(): ToolInfo[] {
    return [...this.tools.values()].map((tool) => tool.info);
  }

  /** Validates input against the tool's schema, then executes. */
  async execute(id: string, input: unknown, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(id);
    if (tool === undefined) {
      throw new ToolError("TOOL_NOT_FOUND", id, `Tool "${id}" is not registered`);
    }

    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new ToolError("INVALID_INPUT", id, `Invalid input for tool "${id}": ${details}`);
    }

    try {
      return await tool.execute(parsed.data, context);
    } catch (error) {
      if (error instanceof ToolError) {
        throw error;
      }
      throw new ToolError(
        "EXECUTION_FAILED",
        id,
        `Tool "${id}" failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}
