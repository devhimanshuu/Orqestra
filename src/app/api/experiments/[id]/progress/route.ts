import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { getExperimentProgress } from "@/modules/experiments/experiment.service";

/**
 * GET /api/experiments/:id/progress
 *
 * Progress derived from the persisted case rows on every read, so it can never
 * drift from what actually happened: completed, failed, cancelled, running and
 * pending executions, per candidate. The dashboard polls this while an experiment
 * is still running.
 */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/experiments/[id]/progress">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    return jsonOk(await getExperimentProgress(user, id));
  } catch (error) {
    return toErrorResponse(error);
  }
}
