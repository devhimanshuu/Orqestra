import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readQuery } from "@/lib/http/request";
import { optimizationHistoryQuerySchema } from "@/modules/optimization/optimization.inputs";
import { getOptimizationHistory } from "@/modules/optimization/optimization.service";

/**
 * GET /api/optimizations/history?projectId=&agentId=&since=&limit=
 *
 * Mutation-strategy effectiveness across sessions, grouped by failure category.
 * Every figure is derived from stored rows: acceptance rates over real
 * evaluated candidates, improvement means over candidates that had a comparable
 * baseline. Unmeasured values are null, and `evidence` states how much measured
 * sample backs each category — an observation is never dressed up as an
 * established effect.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireApiUser();
    const query = optimizationHistoryQuerySchema.parse(Object.fromEntries(readQuery(request)));
    return jsonOk(await getOptimizationHistory(user, query));
  } catch (error) {
    return toErrorResponse(error);
  }
}
