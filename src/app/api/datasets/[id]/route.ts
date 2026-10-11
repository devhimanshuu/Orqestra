import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readJson } from "@/lib/http/request";
import { updateDatasetSchema } from "@/modules/evaluation/dataset.inputs";
import {
  deleteDataset,
  getDatasetDetail,
  updateDataset,
} from "@/modules/evaluation/dataset.service";

/** GET /api/datasets/:id — dataset, its working set and its published versions. */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/datasets/[id]">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    return jsonOk(await getDatasetDetail(user, id));
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** PATCH /api/datasets/:id — rename / re-describe (cases live on their own route). */
export async function PATCH(
  request: Request,
  context: RouteContext<"/api/datasets/[id]">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const body = updateDatasetSchema.parse(await readJson(request));
    return jsonOk({ dataset: await updateDataset(user, id, body) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * DELETE /api/datasets/:id — refused while evaluation batches pin this dataset,
 * because deleting it would erase what those results mean.
 */
export async function DELETE(
  _request: Request,
  context: RouteContext<"/api/datasets/[id]">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    await deleteDataset(user, id);
    return jsonOk({ deleted: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
