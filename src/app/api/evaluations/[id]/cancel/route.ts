import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { cancelEvaluationBatch } from "@/modules/evaluation/evaluation.service";

/**
 * POST /api/evaluations/:id/cancel
 *
 * Records the durable cancellation intent, aborts the runs already in flight
 * through the runtime's own cancellation channel, and settles the batch when
 * nothing is running. A cancelled batch keeps every result it already
 * produced — cancelling stops work, it does not erase evidence.
 */
export async function POST(
  _request: Request,
  context: RouteContext<"/api/evaluations/[id]/cancel">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const { batch, runningCases } = await cancelEvaluationBatch(user, id);
    return jsonOk({
      batch: {
        id: batch.id,
        status: batch.status,
        cancelRequestedAt: batch.cancelRequestedAt,
      },
      runningCases,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
