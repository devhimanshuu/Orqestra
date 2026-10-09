/**
 * Runtime event model.
 *
 * Events are the runtime's narration: what started, what finished, what failed,
 * how a loop iterated. They serve three consumers:
 *
 *  - the trace (persisted per step and per run, for the run detail UI);
 *  - live updates (published to Redis, streamed to the browser over SSE);
 *  - future evaluation/analytics (the event stream is the ground truth).
 *
 * The event set is deliberately closed: adding a variant is a deliberate,
 * reviewable change rather than an ad-hoc `{ type: string }` bag.
 */

import type { HarnessNodeType } from "@/modules/harness/harness.schema";
import type { RuntimeErrorPayload } from "../errors/runtime-error";
import type { RuntimeTokenUsage } from "../usage/tracker";

/** Events the runtime can emit, before sequence/timestamp are attached. */
export type RuntimeEventDraft =
  | { type: "RUN_CREATED" }
  | { type: "RUN_STARTED"; entryNode: string }
  | { type: "NODE_STARTED"; nodeId: string; nodeType: HarnessNodeType; label: string }
  | {
      type: "NODE_COMPLETED";
      nodeId: string;
      nodeType: HarnessNodeType;
      status: "succeeded" | "skipped";
      durationMs: number;
    }
  | { type: "NODE_FAILED"; nodeId: string; nodeType: HarnessNodeType; error: RuntimeErrorPayload }
  | { type: "LLM_STARTED"; nodeId: string; provider: string; model: string }
  | {
      type: "LLM_COMPLETED";
      nodeId: string;
      provider: string;
      model: string;
      usage: RuntimeTokenUsage;
      latencyMs: number;
    }
  | {
      type: "LLM_FAILED";
      nodeId: string;
      provider: string;
      model: string;
      error: RuntimeErrorPayload;
    }
  | { type: "TOOL_STARTED"; nodeId: string; toolId: string }
  | { type: "TOOL_COMPLETED"; nodeId: string; toolId: string; durationMs: number }
  | { type: "TOOL_FAILED"; nodeId: string; toolId: string; error: RuntimeErrorPayload }
  | { type: "LOOP_STARTED"; nodeId: string; maxIterations: number }
  | { type: "LOOP_ITERATION"; nodeId: string; iteration: number; maxIterations: number }
  | { type: "LIMIT_EXCEEDED"; limit: string; used: number; max: number }
  | { type: "RUN_COMPLETED"; status: "completed"; durationMs: number }
  | { type: "RUN_FAILED"; status: "failed"; error: RuntimeErrorPayload }
  | { type: "RUN_CANCELLED"; reason: string }
  | { type: "RUN_TIMED_OUT"; error: RuntimeErrorPayload };

/** A fully formed event: identified, sequenced, timestamped. */
export type RuntimeEvent = RuntimeEventDraft & {
  runId: string;
  /** Monotonic per run, starting at 1 — the trace's ordering key. */
  seq: number;
  /** ISO timestamp (UTC). */
  at: string;
};

export type RuntimeEventType = RuntimeEvent["type"];
