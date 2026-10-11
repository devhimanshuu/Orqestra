import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readJson } from "@/lib/http/request";
import { datasetCaseBodySchema } from "@/modules/evaluation/dataset.inputs";
import { datasetRepository } from "@/modules/evaluation/dataset.repository";
import { assertDatasetAccess } from "@/modules/access/access.service";
import { addDatasetCase, getDatasetDetail } from "@/modules/evaluation/dataset.service";

/**
 * GET  /api/datasets/:id/cases — the working set
 * POST /api/datasets/:id/cases — add one test case
 *
 * Editing the working set never changes a published version, so existing
 * evaluations keep their meaning.
 */

export async function GET(
  _request: Request,
  context: RouteContext<"/api/datasets/[id]/cases">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    await assertDatasetAccess(user.id, id);
    return jsonOk({ cases: await datasetRepository.listCases(id) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/datasets/[id]/cases">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const body = datasetCaseBodySchema.parse(await readJson(request));
    const created = await addDatasetCase(user, id, body);
    // The detail shape is returned so the editor can refresh counts in one go.
    const detail = await getDatasetDetail(user, id);
    return jsonOk({ case: created, caseCount: detail.caseCount }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
