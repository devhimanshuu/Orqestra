import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { pauseExperiment } from "@/modules/experiments/experiment.service";

/**
 * POST /api/experiments/:id/pause
 *
 * Pause semantics, stated exactly: the durable `pausedAt` flag is set and the
 * experiment moves to PAUSED. The orchestrator stops *scheduling* new cases;
 * cases already in flight are allowed to finish and are persisted normally
 * (a case cannot be un-launched mid-node). Nothing is discarded, and resuming
 * picks up exactly the cases that never started.
 */
export async function POST(
  _request: Request,
  context: RouteContext<"/api/experiments/[id]/pause">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const experiment = await pauseExperiment(user, id);
    return jsonOk({
      experiment: {
        id: experiment.id,
        status: experiment.status,
        pausedAt: experiment.pausedAt,
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
