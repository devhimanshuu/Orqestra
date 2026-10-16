import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readJson } from "@/lib/http/request";
import { createOptimizationSessionSchema } from "@/modules/optimization/optimization.inputs";
import { planOptimization } from "@/modules/optimization/optimization.service";

/**
 * POST /api/optimizations/plan — pre-flight a configuration that is not stored yet.
 *
 * Resolves the baseline version, the source batch, the dataset version and the
 * evaluator revisions, then reports what would be sealed and what the ceilings
 * allow — including whether the run budget can cover a single candidate. Nothing
 * is written.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireApiUser();
    const body = createOptimizationSessionSchema.parse(await readJson(request));
    return jsonOk(await planOptimization(user, body));
  } catch (error) {
    return toErrorResponse(error);
  }
}
