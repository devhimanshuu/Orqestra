import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readJson, readQuery } from "@/lib/http/request";
import { createDatasetSchema, listDatasetsQuerySchema } from "@/modules/evaluation/dataset.inputs";
import { createDataset, listDatasets } from "@/modules/evaluation/dataset.service";

/**
 * GET  /api/datasets — datasets the caller may see (optionally by project, searchable)
 * POST /api/datasets — create a dataset from a name (and optionally inline cases)
 *
 * Datasets are user data: the service re-validates every case and resolves
 * project ownership before writing anything.
 */

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireApiUser();
    const query = listDatasetsQuerySchema.parse(Object.fromEntries(readQuery(request)));
    const result = await listDatasets(user, query);
    return jsonOk(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireApiUser();
    const body = createDatasetSchema.parse(await readJson(request));
    const result = await createDataset(user, body);
    return jsonOk(result, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
