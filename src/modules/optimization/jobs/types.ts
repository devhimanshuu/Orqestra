import type { OptimizationRunSummary } from "./orchestrator";

/** What a processed optimization job reports back to the worker's log. */
export type OptimizationJobOutcome = { kind: "optimization"; summary: OptimizationRunSummary };
