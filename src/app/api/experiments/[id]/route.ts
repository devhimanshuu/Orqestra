import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readJson } from "@/lib/http/request";
import { updateExperimentSchema } from "@/modules/experiments/experiment.inputs";
import { getExperiment, updateExperiment } from "@/modules/experiments/experiment.service";

/**
 * GET   /api/experiments/:id — detail: sealed config, candidates and live progress
 * PATCH /api/experiments/:id — update a DRAFT (a sealed experiment is immutable)
 *
 * Every identifier in the response is resolved server-side through the
 * workspace → project → agent chain, so a nested id cannot be used to reach
 * another tenant's harness, dataset or runs.
 */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/experiments/[id]">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    return jsonOk(await getExperiment(user, id));
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/experiments/[id]">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const body = updateExperimentSchema.parse(await readJson(request));
    return jsonOk({ experiment: await updateExperiment(user, id, body) });
  } catch (error) {
    return toErrorResponse(error);
  }
}
