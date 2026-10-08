import { requireApiUser } from "@/lib/auth/api-session";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { jsonOk } from "@/lib/http/api-response";
import { getToolRegistry } from "@/modules/tools";

/**
 * GET /api/tools — serializable tool descriptors for the node inspector's
 * tool picker. Execution is Phase 2; this endpoint only exposes what exists.
 */
export async function GET(): Promise<Response> {
  try {
    await requireApiUser();
    return jsonOk({ tools: getToolRegistry().list() });
  } catch (error) {
    return toErrorResponse(error);
  }
}
