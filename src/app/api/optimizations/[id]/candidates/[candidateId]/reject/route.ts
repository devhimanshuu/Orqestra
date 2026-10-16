import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readJson } from "@/lib/http/request";
import { rejectCandidateSchema } from "@/modules/optimization/optimization.inputs";
import { rejectOptimizationCandidate } from "@/modules/optimization/optimization.service";

/**
 * POST /api/optimizations/:id/candidates/:candidateId/reject
 *
 * Rejects a parked candidate with a required reason. The candidate keeps its
 * change set and validation for the audit trail, but loses the definition it
 * would have published, so no pass can evaluate it later; its hypothesis is
 * marked exhausted and the loop continues with the next one.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/optimizations/[id]/candidates/[candidateId]/reject">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id, candidateId } = await context.params;
    const body = rejectCandidateSchema.parse(await readJson(request));
    const result = await rejectOptimizationCandidate(user, id, candidateId, body);
    return jsonOk({
      session: { id: result.session.id, status: result.session.status },
      candidate: { id: result.candidate.id, label: result.candidate.label },
      dispatch: result.dispatch,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
