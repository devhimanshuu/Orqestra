import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { cancelExperiment } from "@/modules/experiments/experiment.service";

/**
 * POST /api/experiments/:id/cancel
 *
 * Records the durable cancellation intent, aborts the runs already in flight
 * through the runtime's own cancellation channel, marks the cases that never
 * started as cancelled and settles the experiment. Completed results are kept:
 * cancelling stops work, it does not erase evidence.
 */
export async function POST(
  _request: Request,
  context: RouteContext<"/api/experiments/[id]/cancel">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const { experiment, runningExecutions } = await cancelExperiment(user, id);
    return jsonOk({
      experiment: {
        id: experiment.id,
        status: experiment.status,
        cancelRequestedAt: experiment.cancelRequestedAt,
        completedAt: experiment.completedAt,
      },
      runningExecutions,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
