import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readJson } from "@/lib/http/request";
import { validateEvaluatorConfigSchema } from "@/modules/evaluation/evaluator.inputs";
import { validateConfig } from "@/modules/evaluation/evaluator.service";

/**
 * POST /api/evaluators/validate
 *
 * Validates a configuration against its evaluator kind without saving it —
 * the editor's "Check configuration" action. A 200 with `ok: false` and the
 * issue list is the expected answer for a bad draft; that is not an error.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    await requireApiUser();
    const body = validateEvaluatorConfigSchema.parse(await readJson(request));
    return jsonOk(validateConfig(body.kind, body.config));
  } catch (error) {
    return toErrorResponse(error);
  }
}
