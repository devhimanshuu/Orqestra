import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readJson } from "@/lib/http/request";
import { datasetCaseUpdateSchema } from "@/modules/evaluation/dataset.inputs";
import { removeDatasetCase, updateDatasetCase } from "@/modules/evaluation/dataset.service";

/**
 * PATCH  /api/datasets/:id/cases/:caseKey — edit one case (the key is stable)
 * DELETE /api/datasets/:id/cases/:caseKey — remove it from the working set
 */

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/datasets/[id]/cases/[caseKey]">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id, caseKey } = await context.params;
    const body = datasetCaseUpdateSchema.parse(await readJson(request));
    return jsonOk({ case: await updateDatasetCase(user, id, caseKey, body) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(
  _request: Request,
  context: RouteContext<"/api/datasets/[id]/cases/[caseKey]">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id, caseKey } = await context.params;
    await removeDatasetCase(user, id, caseKey);
    return jsonOk({ deleted: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
