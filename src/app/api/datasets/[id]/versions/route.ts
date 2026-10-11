import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readJson } from "@/lib/http/request";
import { publishDatasetVersionSchema } from "@/modules/evaluation/dataset.inputs";
import { datasetRepository } from "@/modules/evaluation/dataset.repository";
import { assertDatasetAccess } from "@/modules/access/access.service";
import { publishDatasetVersion } from "@/modules/evaluation/dataset.service";

/**
 * GET  /api/datasets/:id/versions — immutable snapshots, newest first
 * POST /api/datasets/:id/versions — publish the current working set
 *
 * Publishing an unchanged corpus returns the existing version instead of
 * creating a duplicate, so a version number always means a different corpus.
 */

export async function GET(
  _request: Request,
  context: RouteContext<"/api/datasets/[id]/versions">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    await assertDatasetAccess(user.id, id);
    return jsonOk({ versions: await datasetRepository.listVersions(id) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/datasets/[id]/versions">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const body = publishDatasetVersionSchema.parse(await readJson(request));
    const result = await publishDatasetVersion(user, id, body);
    return jsonOk(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
