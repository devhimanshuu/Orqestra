import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { resumeExperiment } from "@/modules/experiments/experiment.service";

/**
 * POST /api/experiments/:id/resume
 *
 * Clears the pause and re-dispatches the orchestrator. Resumption never replays
 * finished work: a case is claimed with a conditional PENDING → RUNNING update,
 * so only the executions that never started are picked up. The re-dispatch carries
 * a fresh queue nonce, because a paused experiment's original job may still exist
 * and BullMQ de-duplicates by id.
 */
export async function POST(
  _request: Request,
  context: RouteContext<"/api/experiments/[id]/resume">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const { experiment, dispatch } = await resumeExperiment(user, id);
    return jsonOk({
      experiment: {
        id: experiment.id,
        status: experiment.status,
        pausedAt: experiment.pausedAt,
      },
      dispatch,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
