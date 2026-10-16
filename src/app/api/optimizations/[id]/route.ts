import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readJson } from "@/lib/http/request";
import { updateOptimizationSessionSchema } from "@/modules/optimization/optimization.inputs";
import { getOptimizationSession, updateOptimizationSession } from "@/modules/optimization/optimization.service";

/**
 * GET   /api/optimizations/:id — detail: sealed frame, findings, hypotheses,
 *                               candidates with their change sets and verdicts,
 *                               the timeline, the ranking and live progress
 * PATCH /api/optimizations/:id — update a DRAFT (a started session is sealed)
 *
 * Every identifier in the response was resolved server-side through the
 * workspace → project → agent chain, so a nested id cannot reach another tenant.
 */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/optimizations/[id]">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    return jsonOk(await getOptimizationSession(user, id));
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  context: RouteContext<"/api/optimizations/[id]">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const body = updateOptimizationSessionSchema.parse(await readJson(request));
    return jsonOk({ session: (await updateOptimizationSession(user, id, body)).session });
  } catch (error) {
    return toErrorResponse(error);
  }
}
