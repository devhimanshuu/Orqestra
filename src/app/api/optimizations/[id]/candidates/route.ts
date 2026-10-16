import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readQuery } from "@/lib/http/request";
import { optimizationCandidatesQuerySchema } from "@/modules/optimization/optimization.inputs";
import { listOptimizationCandidates } from "@/modules/optimization/optimization.service";

/**
 * GET /api/optimizations/:id/candidates?status=&limit=&offset=
 *
 * Every candidate ever proposed for this session, with its change set, its
 * validation outcome, its acceptance decision and the batch that measured it.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/optimizations/[id]/candidates">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const query = optimizationCandidatesQuerySchema.parse(Object.fromEntries(readQuery(request)));
    return jsonOk(await listOptimizationCandidates(user, id, query));
  } catch (error) {
    return toErrorResponse(error);
  }
}
