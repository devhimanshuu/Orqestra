/**
 * Run event bus — how execution updates reach the browser, and how a cancel
 * request reaches a running job.
 *
 * Two transports, one API:
 *  - **Redis pub/sub** (`orqestra:runs:<runId>`) carries events across
 *    processes: worker → web server → SSE clients. Required for queue mode.
 *  - **In-process listeners** cover inline execution (development without
 *    Redis), where the run and the SSE stream share a Node process, and make
 *    tests able to observe a run without infrastructure.
 *
 * Events are keyed by the runtime's monotonic `seq`, so a subscriber that sees
 * the same event twice (local + Redis echo) can drop the duplicate.
 *
 * Cancellation is a durable intent, not a message: the API writes the run row's
 * `cancelRequestedAt` *and* a cancellation channel entry. The inline path checks
 * the in-process set, the worker path checks Redis — either way the runtime
 * observes it between nodes and aborts in-flight provider/tool calls.
 */

import { createRedisClient } from "@/lib/redis/connection";
import { logger } from "@/lib/logging/logger";
import type { Redis } from "ioredis";
import type { RuntimeEvent } from "./events";

export const RUN_EVENT_CHANNEL_PREFIX = "orqestra:runs:";
const CANCEL_KEY_PREFIX = "orqestra:run:cancel:";
const CANCEL_TTL_SECONDS = 60 * 60;

export function runEventChannel(runId: string): string {
  return `${RUN_EVENT_CHANNEL_PREFIX}${runId}`;
}

export function runCancelKey(runId: string): string {
  return `${CANCEL_KEY_PREFIX}${runId}`;
}

type RunEventListener = (event: RuntimeEvent) => void;

const localListeners = new Map<string, Set<RunEventListener>>();
const locallyCancelled = new Set<string>();

/** Synchronous local fan-out — the transport that always works. */
export function publishRunEventLocally(runId: string, event: RuntimeEvent): void {
  for (const listener of localListeners.get(runId) ?? []) {
    try {
      listener(event);
    } catch (error) {
      logger.warn("run event listener failed", {
        runId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Cross-process fan-out. Queue mode needs Redis; inline mode does not — a
 * failed publish is degraded, not fatal, because local listeners already got
 * the event.
 */
export async function publishRunEventToRedis(runId: string, event: RuntimeEvent): Promise<void> {
  try {
    const client = getPublisher();
    await client.publish(runEventChannel(runId), JSON.stringify(event));
  } catch (error) {
    logger.debug("run event publish skipped", {
      runId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Publishes to every transport (convenience for callers outside the executor). */
export async function publishRunEvent(runId: string, event: RuntimeEvent): Promise<void> {
  publishRunEventLocally(runId, event);
  await publishRunEventToRedis(runId, event);
}

/**
 * Subscribes to a run's events. Returns an unsubscribe function.
 * `onEvent` must tolerate duplicates (the caller filters by `seq`).
 */
export async function subscribeToRun(
  runId: string,
  onEvent: RunEventListener,
): Promise<() => void> {
  const listeners = localListeners.get(runId) ?? new Set<RunEventListener>();
  listeners.add(onEvent);
  localListeners.set(runId, listeners);

  let subscriber: Redis | null = null;
  let channelHandler: ((channel: string, message: string) => void) | null = null;

  try {
    // Fail fast when Redis is absent (inline mode): retrying forever would spam
    // logs and keep the process alive for no benefit. Local listeners cover it.
    subscriber = createRedisClient({
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    // A dedicated subscriber connection: ioredis cannot run commands while in
    // subscriber mode, and BullMQ owns its own connections.
    await subscriber.subscribe(runEventChannel(runId));
    channelHandler = (channel: string, message: string): void => {
      if (channel !== runEventChannel(runId)) {
        return;
      }
      try {
        onEvent(JSON.parse(message) as RuntimeEvent);
      } catch (error) {
        logger.warn("run event payload was not JSON", {
          runId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };
    subscriber.on("message", channelHandler);
  } catch (error) {
    // No Redis: local-only streaming (inline mode). Degrade, never fail.
    logger.debug("run event subscription is local-only", {
      runId,
      message: error instanceof Error ? error.message : String(error),
    });
    if (subscriber !== null) {
      subscriber.disconnect();
      subscriber = null;
    }
  }

  return () => {
    const current = localListeners.get(runId);
    if (current !== undefined) {
      current.delete(onEvent);
      if (current.size === 0) {
        localListeners.delete(runId);
      }
    }
    if (subscriber !== null && channelHandler !== null) {
      subscriber.off("message", channelHandler);
      subscriber.unsubscribe(runEventChannel(runId)).catch(() => undefined);
      subscriber.disconnect();
    }
  };
}

// --- cancellation -----------------------------------------------------------

/** Records cancellation intent locally and (best effort) in Redis. */
export async function requestRunCancellation(runId: string, reason: string): Promise<void> {
  locallyCancelled.add(runId);
  try {
    await getPublisher().set(runCancelKey(runId), reason, "EX", CANCEL_TTL_SECONDS);
  } catch (error) {
    logger.warn("cancellation channel unavailable — relying on the run row", {
      runId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** True when cancellation was requested for this run (local set or Redis). */
export async function isRunCancellationRequested(runId: string): Promise<boolean> {
  if (locallyCancelled.has(runId)) {
    return true;
  }
  try {
    const value = await getPublisher().get(runCancelKey(runId));
    return value !== null;
  } catch {
    return false;
  }
}

/** Clears cancellation state once a run has terminated. */
export async function clearRunCancellation(runId: string): Promise<void> {
  locallyCancelled.delete(runId);
  try {
    await getPublisher().del(runCancelKey(runId));
  } catch {
    // Not fatal: the key expires on its own.
  }
}

// --- publisher connection ---------------------------------------------------

let publisher: Redis | null = null;

/**
 * Shared publisher connection.
 *
 * Separate from the app's shared client: publishing must not be blocked by a
 * subscriber-mode connection, and it must survive Redis being absent (inline).
 */
function getPublisher(): Redis {
  if (publisher === null) {
    publisher = createRedisClient({
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      // Give up instead of reconnecting forever; each publish attempt that
      // matters creates a fresh command on this client.
      retryStrategy: () => null,
    });
  }
  return publisher;
}
