import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readJson } from "@/lib/http/request";
import { importDatasetBodySchema } from "@/modules/evaluation/dataset.inputs";
import { importDataset } from "@/modules/evaluation/dataset.service";

/**
 * POST /api/datasets/import
 *
 * Body: { projectId, document, mode: "create" | "replace", datasetId? }
 *
 * The document is validated as a whole before anything is written, and on
 * failure the response lists every problem with its path — the point of an
 * import is to fix the file, which needs all the errors, not the first one.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireApiUser();
    const body = importDatasetBodySchema.parse(await readJson(request));
    const result = await importDataset(user, body);
    return jsonOk(result, { status: result.replaced ? 200 : 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
