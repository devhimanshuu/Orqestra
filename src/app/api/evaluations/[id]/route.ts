import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { getEvaluationBatch } from "@/modules/evaluation/evaluation.service";

/**
 * GET /api/evaluations/:id — batch, live progress and the labels around it.
 *
 * Progress is computed from the case rows on every read, so it can never drift
 * from what actually happened.
 */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/evaluations/[id]">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    return jsonOk(await getEvaluationBatch(user, id));
  } catch (error) {
    return toErrorResponse(error);
  }
}
