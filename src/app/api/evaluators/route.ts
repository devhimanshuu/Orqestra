import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readJson, readQuery } from "@/lib/http/request";
import { createEvaluatorSchema, listEvaluatorsQuerySchema } from "@/modules/evaluation/evaluator.inputs";
import { createEvaluator, listEvaluators, listKinds } from "@/modules/evaluation/evaluator.service";

/**
 * GET  /api/evaluators — configured evaluators (optionally by project/kind),
 *                       plus the available evaluator kinds for the picker
 * POST /api/evaluators — create one (configuration validated against its kind)
 */

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireApiUser();
    const query = listEvaluatorsQuerySchema.parse(Object.fromEntries(readQuery(request)));
    const evaluators = await listEvaluators(user, query);
    return jsonOk({ evaluators, kinds: listKinds() });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireApiUser();
    const body = createEvaluatorSchema.parse(await readJson(request));
    return jsonOk({ evaluator: await createEvaluator(user, body) }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
