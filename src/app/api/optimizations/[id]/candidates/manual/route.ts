import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readJson } from "@/lib/http/request";
import { attachManualCandidateSchema } from "@/modules/optimization/optimization.inputs";
import { attachManualCandidate } from "@/modules/optimization/optimization.service";

/**
 * POST /api/optimizations/:id/candidates/manual
 *
 * Attaches a harness version the developer published from the builder as a
 * candidate of an open session. Attaching is itself the human approval: the next
 * pass evaluates that version over the session's dataset and evaluators and
 * compares it against the baseline, exactly like a proposed candidate.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/optimizations/[id]/candidates/manual">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const body = attachManualCandidateSchema.parse(await readJson(request));
    const result = await attachManualCandidate(user, id, body);
    return jsonOk(
      {
        session: { id: result.session.id, status: result.session.status },
        candidate: {
          id: result.candidate.id,
          label: result.candidate.label,
          status: result.candidate.status,
          validation: result.candidate.validation,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
