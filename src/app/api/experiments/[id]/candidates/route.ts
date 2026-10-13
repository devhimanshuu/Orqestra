import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { getExperimentCandidates } from "@/modules/experiments/experiment.service";

/**
 * GET /api/experiments/:id/candidates
 *
 * The candidates with their immutable harness pins, their per-replicate batch
 * statuses, their progress and their metrics — plus the objective-based ranking.
 * One load, metrics only: no per-case statistical claim is made here, so a caller
 * that needs paired evidence asks the comparison endpoint instead.
 */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/experiments/[id]/candidates">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    return jsonOk(await getExperimentCandidates(user, id));
  } catch (error) {
    return toErrorResponse(error);
  }
}
