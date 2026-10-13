import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readQuery } from "@/lib/http/request";
import { experimentCasesQuerySchema } from "@/modules/experiments/experiment.inputs";
import { listExperimentCases } from "@/modules/experiments/experiment.service";

/**
 * GET /api/experiments/:id/cases[?candidateId=&status=&limit=&offset=]
 *
 * Per-case results, aligned by stable dataset case key with the baseline beside
 * each candidate — never by position, so unrelated cases are never compared as
 * though they were equivalent. Each trial carries the run that produced it, which
 * is what makes a score traceable back to an exact execution.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/experiments/[id]/cases">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const query = experimentCasesQuerySchema.parse(Object.fromEntries(readQuery(request)));
    return jsonOk(await listExperimentCases(user, id, query));
  } catch (error) {
    return toErrorResponse(error);
  }
}
