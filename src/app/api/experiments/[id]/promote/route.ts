import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readJson } from "@/lib/http/request";
import { promoteCandidateSchema } from "@/modules/experiments/experiment.inputs";
import { promoteCandidate } from "@/modules/experiments/experiment.service";

/**
 * POST /api/experiments/:id/promote
 *
 * Advances the harness to the selected candidate's *immutable* version. The
 * advancement is delegated to the harness service's own promotion rule
 * (forward-only, gated on the winning batch's pass rate), so a promotion can never
 * roll a harness back and never mutates a published version. The decision is
 * recorded on the experiment, with the warnings that were shown.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/experiments/[id]/promote">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const body = promoteCandidateSchema.parse(await readJson(request));
    const result = await promoteCandidate(user, id, body);
    return jsonOk({
      experiment: {
        id: result.experiment.id,
        promotedCandidateId: result.experiment.promotedCandidateId,
        promotionNotes: result.experiment.promotionNotes,
        promotedAt: result.experiment.promotedAt,
      },
      candidate: { id: result.candidate.id, label: result.candidate.label },
      harnessVersion: result.harnessVersion,
      promotedFrom: result.promotedFrom,
      warnings: result.warnings,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
