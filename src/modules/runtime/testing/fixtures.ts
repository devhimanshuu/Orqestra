/**
 * Test fixtures for the runtime.
 *
 * Not a test file itself: helpers shared by compiler, executor and engine tests.
 * The fixture harnesses are the same shapes the builder produces (validated by
 * the real validator), so a passing test means a runnable harness.
 */

import type { HarnessDefinition } from "@/modules/harness/harness.schema";
import { getLLMGateway } from "@/modules/llm/llm.gateway";
import { getToolRegistry } from "@/modules/tools";
import { logger } from "@/lib/logging/logger";
import { executeHarness, type ExecuteHarnessOptions, type ExecuteHarnessOutcome } from "../executor/engine";

type NodeSpec = {
  id: string;
  type: string;
  label: string;
  config?: Record<string, unknown>;
  description?: string;
};

export function node(
  id: string,
  type: NodeSpec["type"],
  label: string,
  config: Record<string, unknown> = {},
  description?: string,
): Record<string, unknown> {
  return {
    id,
    type,
    label,
    config,
    position: { x: 0, y: 0 },
    ...(description !== undefined ? { description } : {}),
  };
}

export function edge(
  id: string,
  source: string,
  target: string,
  sourceHandle?: string,
  label?: string,
): Record<string, unknown> {
  return {
    id,
    source,
    target,
    ...(sourceHandle !== undefined ? { sourceHandle } : {}),
    ...(label !== undefined ? { label } : {}),
  };
}

export function harness(
  nodes: Array<Record<string, unknown>>,
  edges: Array<Record<string, unknown>>,
  options: { id?: string; name?: string; version?: number } = {},
): HarnessDefinition {
  const startNode = nodes.find((entry) => entry["type"] === "start");
  const exitNodes = nodes.filter((entry) => entry["type"] === "end").map((entry) => entry["id"] as string);
  return {
    schemaVersion: 2,
    id: options.id ?? "test-harness",
    version: options.version ?? 1,
    name: options.name ?? "Test harness",
    nodes,
    edges,
    entryNode: (startNode?.["id"] as string | undefined) ?? "start",
    exitNodes,
  } as HarnessDefinition;
}

/** START → TRANSFORM → CONDITION → (true) END | (false) PROMPT → END */
export function branchingHarness(score: number): HarnessDefinition {
  return harness(
    [
      node("start", "start", "Start"),
      node("seed", "transform", "Seed score", { expression: `{ score: ${score} }` }),
      node("gate", "condition", "Score gate", { expression: "state.score >= 0.8" }),
      node("ok", "end", "End (passed)"),
      node("retry_prompt", "prompt", "Retry prompt", { template: "Score {{ state.score }} was too low" }),
      node("fail", "end", "End (too low)"),
    ],
    [
      edge("e0", "start", "seed"),
      edge("e1", "seed", "gate"),
      edge("e2", "gate", "ok", "true"),
      edge("e3", "gate", "retry_prompt", "false"),
      edge("e4", "retry_prompt", "fail"),
    ],
    { id: "branching", name: "Branching harness" },
  );
}

/**
 * The canonical agentic loop (START → LOOP → PLANNER → TOOL → CRITIC →
 * CONDITION → END | LOOP) with an explicit loop node, as the harness validator
 * requires for any cycle.
 */
export function researchLoopHarness(options: { maxIterations?: number; threshold?: number } = {}): HarnessDefinition {
  return harness(
    [
      node("start", "start", "Start"),
      node("loop", "loop", "Refine loop", { maxIterations: options.maxIterations ?? 3 }),
      node("planner", "planner", "Planner", {
        instructions: "Break the research task into steps.",
        maxSteps: 4,
      }),
      node("clock", "tool", "Clock", { toolId: "current_time" }),
      node("critic", "critic", "Critic", {
        instructions: "Review the plan for coverage and evidence.",
        threshold: options.threshold ?? 0.7,
      }),
      node("gate", "condition", "Score gate", { expression: "state.score >= 0.7" }),
      node("done", "end", "End"),
    ],
    [
      edge("e0", "start", "loop"),
      edge("e1", "loop", "planner", "body"),
      edge("e2", "planner", "clock"),
      edge("e3", "clock", "critic"),
      edge("e4", "critic", "gate"),
      edge("e5", "gate", "done", "true"),
      edge("e6", "gate", "loop", "false"),
      edge("e7", "loop", "done", "exit"),
    ],
    { id: "research-loop", name: "Research harness" },
  );
}

/** START → LOOP → (body) MEMORY → CONDITION(never true) → LOOP | (exit) END */
export function memoryLoopHarness(maxIterations = 2): HarnessDefinition {
  return harness(
    [
      node("start", "start", "Start"),
      node("loop", "loop", "Accumulate", { maxIterations }),
      node("remember", "memory", "Remember", { scope: "run", maxItems: 5 }),
      node("gate", "condition", "Enough?", { expression: "state.memorySize >= 99" }),
      node("done", "end", "End"),
    ],
    [
      edge("e0", "start", "loop"),
      edge("e1", "loop", "remember", "body"),
      edge("e2", "remember", "gate"),
      edge("e3", "gate", "loop", "false"),
      edge("e4", "gate", "done", "true"),
      edge("e5", "loop", "done", "exit"),
    ],
    { id: "memory-loop", name: "Memory loop harness" },
  );
}

export type RunFixtureOptions = Partial<ExecuteHarnessOptions> & {
  definition: unknown;
  input: unknown;
};

/** Executes a harness with the real gateway (mock provider) and tool registry. */
export async function runFixture(options: RunFixtureOptions): Promise<ExecuteHarnessOutcome> {
  const {
    definition,
    input,
    gateway = getLLMGateway(),
    toolRegistry = getToolRegistry(),
    ...rest
  } = options;

  return executeHarness({
    runId: rest.runId ?? "run-test",
    harnessVersionId: rest.harnessVersionId ?? "version-test",
    definition,
    input,
    agent: rest.agent ?? null,
    gateway,
    toolRegistry,
    logger,
    ...rest,
  });
}
