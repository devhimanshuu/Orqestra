import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readJson } from "@/lib/http/request";
import { approveCandidateSchema } from "@/modules/optimization/optimization.inputs";
import { approveOptimizationCandidate } from "@/modules/optimization/optimization.service";

/**
 * POST /api/optimizations/:id/candidates/:candidateId/approve
 *
 * Records an attributed human approval of a candidate the loop parked for review,
 * then resumes the loop. The pass publishes the *exact* definition that was
 * approved (it is stored with the candidate), evaluates it through the existing
 * evaluation infrastructure, and compares it against the baseline.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/optimizations/[id]/candidates/[candidateId]/approve">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id, candidateId } = await context.params;
    const body = approveCandidateSchema.parse(await readJson(request));
    const result = await approveOptimizationCandidate(user, id, candidateId, body);
    return jsonOk({
      session: { id: result.session.id, status: result.session.status },
      candidate: { id: result.candidate.id, label: result.candidate.label },
      dispatch: result.dispatch,
      checks: result.review.checks,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
