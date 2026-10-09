import { z } from "zod";
import type { AgentTool, ToolResult } from "../tool.types";

/**
 * Current date/time.
 *
 * The deterministic anchor for time-sensitive harnesses: nodes never call
 * `Date.now()` themselves (that would make a run non-reproducible), they read
 * the clock through this tool and store the value in run state.
 *
 * The input is deliberately permissive — a tool node wires whatever flows in
 * (the run task, a planner's plan, …) — so the tool ignores unrelated input and
 * only honours an optional `{ timeZone }`. That makes it the canonical "safe
 * no-argument tool" for loop bodies and smoke tests.
 */

const inputSchema = z.unknown().optional();

type Input = z.infer<typeof inputSchema>;
type Output = {
  iso: string;
  epochMs: number;
  timeZone: string;
  formatted: string;
};

function readTimeZone(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const value = (input as Record<string, unknown>)["timeZone"];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export const currentTimeTool: AgentTool<Input, Output> = {
  id: "current_time",
  name: "Current time",
  description: "Returns the server's current date and time (ISO 8601, epoch ms, localised text).",
  version: 1,
  inputSchema,
  async execute(input: Input): Promise<ToolResult<Output>> {
    const startedAt = performance.now();
    const now = new Date();
    const timeZone =
      readTimeZone(input) ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";

    let formatted: string;
    try {
      formatted = new Intl.DateTimeFormat("en-GB", {
        timeZone,
        dateStyle: "medium",
        timeStyle: "long",
      }).format(now);
    } catch {
      formatted = now.toISOString();
    }

    return {
      output: { iso: now.toISOString(), epochMs: now.getTime(), timeZone, formatted },
      durationMs: Math.round(performance.now() - startedAt),
    };
  },
};
