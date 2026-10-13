import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readQuery } from "@/lib/http/request";
import { getExperimentMetricsView } from "@/modules/experiments/experiment.service";

/**
 * GET /api/experiments/:id/metrics[?withAnalysis=true]
 *
 * Candidate metrics and the objective-based ranking, calculated from persisted
 * case executions only. `withAnalysis` adds the per-case, paired evidence; the
 * default is metrics-only, which is what a progress poll needs.
 *
 * A candidate that violates a hard constraint is never reported as the winner:
 * its rank carries the constraint that blocked it and the reason.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/experiments/[id]/metrics">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const query = readQuery(request);
    const withAnalysis = query.get("withAnalysis") === "true" || query.get("withAnalysis") === "1";
    return jsonOk(await getExperimentMetricsView(user, id, { withAnalysis }));
  } catch (error) {
    return toErrorResponse(error);
  }
}
