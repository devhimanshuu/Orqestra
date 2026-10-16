import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readJson } from "@/lib/http/request";
import { cancelOptimizationSessionSchema } from "@/modules/optimization/optimization.inputs";
import { cancelOptimizationSession } from "@/modules/optimization/optimization.service";

/**
 * POST /api/optimizations/:id/cancel
 *
 * Sets the durable cancellation flag the loop observes between iterations,
 * candidates and cases, cancels the runs of a candidate evaluation that is in
 * flight, and settles a session that has no live pass immediately. A running pass
 * settles itself with its stopping report, so nothing is lost by cancelling.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/optimizations/[id]/cancel">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const body = cancelOptimizationSessionSchema.parse(await readJson(request));
    const result = await cancelOptimizationSession(user, id, body);
    return jsonOk({
      session: {
        id: result.session.id,
        status: result.session.status,
        stopReason: result.session.stopReason,
        completedAt: result.session.completedAt,
        cancelRequestedAt: result.session.cancelRequestedAt,
      },
      runningRuns: result.runningRuns,
      settledImmediately: result.settledImmediately,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
