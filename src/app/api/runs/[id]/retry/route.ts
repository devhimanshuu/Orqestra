import { requireApiUser } from "@/lib/auth/api-session";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { jsonOk } from "@/lib/http/api-response";
import { retryRun } from "@/modules/runtime/run.service";

/**
 * POST /api/runs/:id/retry — creates a NEW run with the same input and pins.
 * The original run is never mutated, so history stays reproducible.
 */
export async function POST(
  _request: Request,
  context: RouteContext<"/api/runs/[id]/retry">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const { run, dispatch } = await retryRun(user, id);
    return jsonOk(
      {
        run: {
          id: run.id,
          status: run.status,
          attempt: run.attempt,
          retryOfRunId: run.retryOfRunId,
          createdAt: run.createdAt,
        },
        dispatch,
      },
      { status: 202 },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
