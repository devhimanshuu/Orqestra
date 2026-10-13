import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readJson } from "@/lib/http/request";
import { selectCandidateSchema } from "@/modules/experiments/experiment.inputs";
import { selectCandidate } from "@/modules/experiments/experiment.service";

/**
 * POST /api/experiments/:id/select
 *
 * Records the candidate the author selected (or recommends). This changes no
 * harness: it is an attributed decision on the experiment, and the response
 * carries the warnings that were on screen — constraint violations, evaluator
 * coverage, evidence quality — so the trade-off is visible rather than implied.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/experiments/[id]/select">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const body = selectCandidateSchema.parse(await readJson(request));
    const result = await selectCandidate(user, id, body);
    return jsonOk({
      experiment: {
        id: result.experiment.id,
        selectedCandidateId: result.experiment.selectedCandidateId,
        selectionKind: result.experiment.selectionKind,
        selectionNotes: result.experiment.selectionNotes,
        selectedAt: result.experiment.selectedAt,
      },
      candidate: {
        id: result.candidate.id,
        label: result.candidate.label,
        harnessId: result.candidate.harnessId,
        harnessVersionId: result.candidate.harnessVersionId,
        harnessVersion: result.candidate.harnessVersion,
      },
      authorization: result.authorization,
      warnings: result.warnings,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
