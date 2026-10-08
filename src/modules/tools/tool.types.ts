import type { z } from "zod";
import type { Logger } from "@/lib/logging/logger";

/**
 * Tool abstraction — first-class, provider-agnostic capability interface.
 *
 * The runtime never calls a tool directly: it goes through the ToolRegistry,
 * which validates input against the tool's Zod schema and normalizes errors.
 * Tools are code-level plugins in Phase 0; persisted Tool/ToolVersion entities
 * arrive when the tool library ships (they will map onto this interface).
 */

export interface ToolContext {
  logger: Logger;
  /** Cooperative cancellation — the runtime aborts in-flight work on run timeout. */
  signal?: AbortSignal;
  /** Where the call happened: future phases enrich this (runId, nodeId, attempt). */
  metadata: {
    runId?: string;
    nodeId?: string;
    [key: string]: unknown;
  };
}

export interface ToolResult<TOut = unknown> {
  output: TOut;
  /** Wall-clock duration of execute() in milliseconds. */
  durationMs: number;
}

export interface AgentTool<TIn = unknown, TOut = unknown> {
  /** Stable machine id, e.g. "calculator". Referenced by tool nodes. */
  id: string;
  name: string;
  description: string;
  /** Tool version (ToolVersion concept) — bumped when behavior changes. */
  version: number;
  /** Zod schema for input validation. All external input MUST pass through it. */
  inputSchema: z.ZodType<TIn>;
  execute(input: TIn, context: ToolContext): Promise<ToolResult<TOut>>;
}

export type ToolErrorCode = "TOOL_NOT_FOUND" | "INVALID_INPUT" | "EXECUTION_FAILED";

export class ToolError extends Error {
  public readonly code: ToolErrorCode;
  public readonly toolId: string;

  constructor(code: ToolErrorCode, toolId: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ToolError";
    this.code = code;
    this.toolId = toolId;
  }
}

/** Serializable tool descriptor (safe for APIs/UI — no functions). */
export interface ToolInfo {
  id: string;
  name: string;
  description: string;
  version: number;
}
