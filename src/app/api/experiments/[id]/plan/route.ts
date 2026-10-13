import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { planStoredExperiment } from "@/modules/experiments/experiment.service";

/**
 * POST /api/experiments/:id/plan — pre-flight the *stored* configuration.
 *
 * Re-resolved from the database rather than read back from the draft, so the
 * review step reflects what would actually be sealed right now: an evaluator
 * revision, a dataset version or a harness revision that moved on since the
 * draft was saved shows up here before the user commits to a run.
 */
export async function POST(
  _request: Request,
  context: RouteContext<"/api/experiments/[id]/plan">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    return jsonOk(await planStoredExperiment(user, id));
  } catch (error) {
    return toErrorResponse(error);
  }
}
