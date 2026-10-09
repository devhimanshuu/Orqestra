/**
 * Event emitter.
 *
 * The runtime narrates itself through this object; sinks decide what to do with
 * each event (persist it, publish it to Redis for SSE, log it in a test).
 *
 * Two invariants:
 *  - sequence numbers are monotonic per run, assigned here, so ordering never
 *    depends on wall-clock resolution;
 *  - a failing sink can never break a run — errors are isolated and logged.
 */

import type { Logger } from "@/lib/logging/logger";
import type { RuntimeEvent, RuntimeEventDraft } from "./events";

export type RuntimeEventSink = (event: RuntimeEvent) => void | Promise<void>;

export class RuntimeEventEmitter {
  private seq = 0;

  constructor(
    private readonly runId: string,
    private readonly sinks: readonly RuntimeEventSink[],
    private readonly now: () => Date,
    private readonly logger?: Logger,
  ) {}

  emit(draft: RuntimeEventDraft): RuntimeEvent {
    this.seq += 1;
    const event: RuntimeEvent = {
      ...draft,
      runId: this.runId,
      seq: this.seq,
      at: this.now().toISOString(),
    };

    for (const sink of this.sinks) {
      try {
        const result = sink(event);
        if (result instanceof Promise) {
          void result.catch((error: unknown) => this.onSinkError(error));
        }
      } catch (error) {
        this.onSinkError(error);
      }
    }

    return event;
  }

  get lastSequence(): number {
    return this.seq;
  }

  private onSinkError(error: unknown): void {
    this.logger?.warn("runtime event sink failed", {
      runId: this.runId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
