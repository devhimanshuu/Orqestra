import { requireApiUser } from "@/lib/auth/api-session";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { jsonOk } from "@/lib/http/api-response";
import { getToolRegistry } from "@/modules/tools";

/**
 * GET /api/tools — serializable tool descriptors for the node inspector's
 * tool picker. Execution is Phase 2; this endpoint only exposes what exists.
 *
 * Note: Cache Components (next.config.ts) rejects route segment config, so this
 * route relies on `headers()` alone for its request-dependent behaviour. During
 * the build's prerender pass React aborts that read, which is logged as an
 * "unhandled API error" and then handled at request time.
 */
export async function GET(): Promise<Response> {
  try {
    await requireApiUser();
    return jsonOk({ tools: getToolRegistry().list() });
  } catch (error) {
    return toErrorResponse(error);
  }
}
