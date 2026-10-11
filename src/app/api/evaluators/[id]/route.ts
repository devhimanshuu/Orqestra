import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readJson } from "@/lib/http/request";
import { updateEvaluatorSchema } from "@/modules/evaluation/evaluator.inputs";
import { evaluatorRepository } from "@/modules/evaluation/evaluator.repository";
import { assertEvaluatorAccess } from "@/modules/access/access.service";
import { deleteEvaluator, getEvaluator, updateEvaluator } from "@/modules/evaluation/evaluator.service";

/**
 * GET    /api/evaluators/:id — configuration + current revision + revision history
 * PATCH  /api/evaluators/:id — rename/enable, or change the config (new revision)
 * DELETE /api/evaluators/:id — delete it (stored results keep their snapshots)
 */

export async function GET(
  _request: Request,
  context: RouteContext<"/api/evaluators/[id]">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const [evaluator, versions] = await Promise.all([
      getEvaluator(user, id),
      (async () => {
        await assertEvaluatorAccess(user.id, id);
        return evaluatorRepository.listVersions(id);
      })(),
    ]);
    return jsonOk({ evaluator, versions });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/evaluators/[id]">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const body = updateEvaluatorSchema.parse(await readJson(request));
    return jsonOk({ evaluator: await updateEvaluator(user, id, body) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  context: RouteContext<"/api/evaluators/[id]">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    await deleteEvaluator(user, id);
    return jsonOk({ deleted: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
