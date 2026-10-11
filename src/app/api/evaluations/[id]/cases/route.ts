import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readQuery } from "@/lib/http/request";
import { listCasesQuerySchema } from "@/modules/evaluation/evaluation.inputs";
import { listEvaluationCases } from "@/modules/evaluation/evaluation.service";

/**
 * GET /api/evaluations/:id/cases — case-level results, paginated.
 *
 * Results for the page are fetched in one query (never one per case), and the
 * pass verdict is derived from the batch's own threshold rather than frozen.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/evaluations/[id]/cases">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const query = listCasesQuerySchema.parse(Object.fromEntries(readQuery(request)));
    return jsonOk(await listEvaluationCases(user, id, query));
  } catch (error) {
    return toErrorResponse(error);
  }
}
