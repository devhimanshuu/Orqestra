import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readJson } from "@/lib/http/request";
import { promoteOptimizationCandidateSchema } from "@/modules/optimization/optimization.inputs";
import { promoteOptimizationCandidate } from "@/modules/optimization/optimization.service";

/**
 * POST /api/optimizations/:id/promote
 *
 * Advances the harness to a candidate's *immutable* version — the only action
 * that changes an active harness version, and always an attributed human act.
 * The advancement is delegated to the harness service's own forward-only,
 * evidence-gated promotion rule, so a promotion can never rewrite a published
 * version. An `override` is allowed but must carry a reason: it is recorded as a
 * human accepting a known trade-off.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/optimizations/[id]/promote">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const body = promoteOptimizationCandidateSchema.parse(await readJson(request));
    const result = await promoteOptimizationCandidate(user, id, body);
    return jsonOk({
      session: {
        id: result.session.id,
        status: result.session.status,
        promotedCandidateId: result.session.promotedCandidateId,
      },
      candidate: { id: result.candidate.id, label: result.candidate.label },
      harnessVersion: result.harnessVersion,
      promotedFrom: result.promotedFrom,
      warnings: result.warnings,
      checks: result.report.checks,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
