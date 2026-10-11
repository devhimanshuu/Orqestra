import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { getEvaluationMetrics } from "@/modules/evaluation/evaluation.service";

/**
 * GET /api/evaluations/:id/metrics
 *
 * The stored aggregate for a settled batch, or a freshly computed one for a
 * batch still in progress. Cost is always reported as an estimate, with the
 * pricing source and any unpriced models named.
 */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/evaluations/[id]/metrics">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    return jsonOk({ metrics: await getEvaluationMetrics(user, id) });
  } catch (error) {
    return toErrorResponse(error);
  }
}
