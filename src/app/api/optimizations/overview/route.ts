import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readQuery } from "@/lib/http/request";
import { getOptimizationOverview } from "@/modules/optimization/optimization.service";

/**
 * GET /api/optimizations/overview?projectId=&agentId=
 *
 * Workspace-scoped counters derived from rows: how many sessions ran, how many
 * produced an accepted improvement, how many candidate evaluations and runs were
 * spent, and what they cost.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireApiUser();
    const query = Object.fromEntries(readQuery(request));
    return jsonOk(
      await getOptimizationOverview(user, {
        ...(typeof query["projectId"] === "string" ? { projectId: query["projectId"] } : {}),
        ...(typeof query["agentId"] === "string" ? { agentId: query["agentId"] } : {}),
      }),
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
