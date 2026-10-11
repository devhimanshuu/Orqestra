import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readJson } from "@/lib/http/request";
import { evaluateRunSchema } from "@/modules/evaluation/evaluation.inputs";
import { evaluateRun, listRunEvaluations } from "@/modules/evaluation/evaluation.service";

/**
 * GET  /api/runs/:id/evaluations — every evaluation attached to this run
 * POST /api/runs/:id/evaluations — score this run with chosen evaluators
 *
 * A run can be evaluated many times (a batch, then a re-score after a rubric
 * change), so GET returns groups. Scoring never alters the run itself.
 */

export async function GET(
  _request: Request,
  context: RouteContext<"/api/runs/[id]/evaluations">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    return jsonOk({ evaluations: await listRunEvaluations(user, id) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/runs/[id]/evaluations">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const body = evaluateRunSchema.parse(await readJson(request));
    return jsonOk({ evaluation: await evaluateRun(user, id, body) }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
