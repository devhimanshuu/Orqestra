import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readQuery } from "@/lib/http/request";
import { optimizationEventsQuerySchema } from "@/modules/optimization/optimization.inputs";
import { listOptimizationEvents } from "@/modules/optimization/optimization.service";

/**
 * GET /api/optimizations/:id/events?limit=&offset=
 *
 * The append-only optimization timeline: analysis, hypotheses, candidate
 * creation, validation failures, approvals, evaluations, decisions and stopping
 * reasons, in the order they happened.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/optimizations/[id]/events">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const query = optimizationEventsQuerySchema.parse(Object.fromEntries(readQuery(request)));
    return jsonOk(await listOptimizationEvents(user, id, query));
  } catch (error) {
    return toErrorResponse(error);
  }
}
