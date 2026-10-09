import { requireApiUser } from "@/lib/auth/api-session";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { runRepository } from "@/modules/runtime/run.repository";
import { getRunDetail, isTerminalRunStatus } from "@/modules/runtime/run.service";
import { subscribeToRun } from "@/modules/runtime/events/bus";
import type { RuntimeEvent } from "@/modules/runtime/events/events";

/**
 * GET /api/runs/:id/events — Server-Sent Events stream for one run.
 *
 * SSE (not WebSockets): the traffic is one-directional and servers/proxies
 * handle it without extra infrastructure.
 *
 * Flow: authorize → replay the persisted events (so a late subscriber sees the
 * whole timeline) → subscribe for live events → close on a terminal event.
 * Duplicate `seq` values are dropped, so a client that also polled the REST
 * endpoint cannot double-apply an update.
 *
 * Transport note: this version of Next.js has Cache Components enabled, so
 * `runtime`/`dynamic` route segment config is rejected — Node.js is the default
 * runtime (which `ioredis` needs for TCP sockets), and an un-cached handler is
 * dynamic by default.
 */

const HEARTBEAT_MS = 15_000;
/** Hard cap on stream lifetime; clients reconnect and re-replay. */
const MAX_STREAM_MS = 10 * 60 * 1_000;

function sseFrame(event: RuntimeEvent): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export async function GET(
  request: Request,
  context: RouteContext<"/api/runs/[id]/events">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;

    // Authorizes the caller and gives us the replay + status in one call.
    const detail = await getRunDetail(user, id);
    const persisted = await runRepository.listEvents(id);

    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let deadline: ReturnType<typeof setTimeout> | null = null;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const seen = new Set<number>();
        let closed = false;

        const close = (): void => {
          if (closed) {
            return;
          }
          closed = true;
          if (heartbeat !== null) {
            clearInterval(heartbeat);
          }
          if (deadline !== null) {
            clearTimeout(deadline);
          }
          unsubscribe?.();
          try {
            controller.close();
          } catch {
            // Already closed by the client.
          }
        };

        const send = (event: RuntimeEvent): void => {
          if (seen.has(event.seq)) {
            return;
          }
          seen.add(event.seq);
          try {
            controller.enqueue(encoder.encode(sseFrame(event)));
          } catch {
            close();
            return;
          }
          if (
            event.type === "RUN_COMPLETED" ||
            event.type === "RUN_FAILED" ||
            event.type === "RUN_CANCELLED" ||
            event.type === "RUN_TIMED_OUT"
          ) {
            close();
          }
        };

        // Replay: a terminal run streams its full history then closes. A
        // terminal event inside the replay closes the controller, so every
        // write after the loop has to check `closed` first — enqueueing into a
        // closed controller throws and fails the whole response.
        for (const entry of persisted) {
          send(entry.payload);
          if (closed) {
            break;
          }
        }

        if (!closed) {
          controller.enqueue(encoder.encode(`: connected ${new Date().toISOString()}\n\n`));
        }

        if (closed || isTerminalRunStatus(detail.run.status)) {
          close();
          return;
        }

        unsubscribe = await subscribeToRun(id, send);
        heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(`: heartbeat\n\n`));
          } catch {
            close();
          }
        }, HEARTBEAT_MS);
        deadline = setTimeout(close, MAX_STREAM_MS);

        request.signal.addEventListener("abort", close, { once: true });
      },
      cancel() {
        unsubscribe?.();
        if (heartbeat !== null) {
          clearInterval(heartbeat);
        }
        if (deadline !== null) {
          clearTimeout(deadline);
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
