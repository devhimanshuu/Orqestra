import type { HarnessDefinition } from "@/modules/harness/harness.schema";

/**
 * The harness definition behind the hero's copy field.
 *
 * It is a real document, not marketing filler: it satisfies the same
 * `HarnessDefinition` type the platform validates, compiles and executes, so
 * pasting it into the builder (Import) or POSTing it as a version produces a
 * runnable harness. The graph is the loop the Phase 2 verification exercises
 * end to end:
 *
 *   start → loop → planner → tool → critic → condition ─┬─ true  → end
 *                                                       └─ false → loop
 *
 * `satisfies` keeps the copy honest: if the DSL changes shape, the build breaks
 * here instead of the clipboard.
 */
export const HARNESS_SAMPLE = {
  schemaVersion: 2,
  id: "research-harness",
  version: 4,
  name: "Research harness",
  description: "Plan, gather, criticise, and stop only when the critique passes.",
  nodes: [
    { id: "start", type: "start", label: "Start", config: {}, position: { x: 0, y: 0 } },
    {
      id: "loop",
      type: "loop",
      label: "Refine until it passes",
      config: { maxIterations: 3 },
      position: { x: 0, y: 120 },
    },
    {
      id: "planner",
      type: "planner",
      label: "Planner",
      config: { instructions: "Break the task into at most four ordered steps.", maxSteps: 4 },
      position: { x: 0, y: 240 },
    },
    {
      id: "clock",
      type: "tool",
      label: "Clock",
      config: { toolId: "current_time" },
      position: { x: 0, y: 360 },
    },
    {
      id: "critic",
      type: "critic",
      label: "Critic",
      config: { instructions: "Score the draft for coverage and evidence.", threshold: 0.8 },
      position: { x: 0, y: 480 },
    },
    {
      id: "gate",
      type: "condition",
      label: "Good enough?",
      config: { expression: "state.score >= 0.8" },
      position: { x: 0, y: 600 },
    },
    { id: "end", type: "end", label: "End", config: {}, position: { x: 0, y: 720 } },
  ],
  edges: [
    { id: "e0", source: "start", target: "loop" },
    { id: "e1", source: "loop", target: "planner", sourceHandle: "body" },
    { id: "e2", source: "planner", target: "clock" },
    { id: "e3", source: "clock", target: "critic" },
    { id: "e4", source: "critic", target: "gate" },
    { id: "e5", source: "gate", target: "end", sourceHandle: "true", label: "passes" },
    { id: "e6", source: "gate", target: "loop", sourceHandle: "false", label: "retry" },
    { id: "e7", source: "loop", target: "end", sourceHandle: "exit" },
  ],
  entryNode: "start",
  exitNodes: ["end"],
} satisfies HarnessDefinition;

/** Pretty-printed definition — exactly what the copy field puts on the clipboard. */
export const HARNESS_SAMPLE_JSON = JSON.stringify(HARNESS_SAMPLE, null, 2);
