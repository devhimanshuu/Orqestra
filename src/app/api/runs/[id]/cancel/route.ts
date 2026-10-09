import { requireApiUser } from "@/lib/auth/api-session";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { jsonOk } from "@/lib/http/api-response";
import { cancelRun } from "@/modules/runtime/run.service";

/**
 * POST /api/runs/:id/cancel
 *
 * Records cancellation intent on the run row *and* on the cancellation channel.
 * A running worker observes it between nodes (and inside in-flight provider and
 * tool calls), so the runtime actually stops instead of being relabelled.
 */
export async function POST(
  _request: Request,
  context: RouteContext<"/api/runs/[id]/cancel">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const run = await cancelRun(user, id);
    return jsonOk({ run: { id: run.id, status: run.status, cancelRequestedAt: run.cancelRequestedAt } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
