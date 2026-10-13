import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readQuery } from "@/lib/http/request";
import { compareExperimentQuerySchema } from "@/modules/experiments/experiment.inputs";
import { compareExperiment } from "@/modules/experiments/experiment.service";

/**
 * GET /api/experiments/:id/compare[?candidateId=&includeCases=true&regressionsOnly=true]
 *
 * Every candidate against the baseline: absolute and percentage differences where
 * they are meaningful, constraint status, the paired per-case evidence and the
 * regression findings. Percentage differences are `null` — not zero, not infinity —
 * when the baseline value is zero or missing, and no significance is claimed from
 * a sample that cannot support it.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/experiments/[id]/compare">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const query = compareExperimentQuerySchema.parse(Object.fromEntries(readQuery(request)));
    return jsonOk(await compareExperiment(user, id, query));
  } catch (error) {
    return toErrorResponse(error);
  }
}
