import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readJson } from "@/lib/http/request";
import { launchExperimentSchema } from "@/modules/experiments/experiment.inputs";
import { launchExperiment } from "@/modules/experiments/experiment.service";

/**
 * POST /api/experiments/:id/launch
 *
 * Seals the experiment — an immutable configuration snapshot, one sealed
 * evaluation batch per candidate replicate, and the interleaved assignment rows —
 * and hands the orchestration to the queue. The request itself never executes a
 * case, and `confirm: true` is required because this is the step that can cost
 * money.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/experiments/[id]/launch">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const body = launchExperimentSchema.parse(await readJson(request));
    const { experiment, dispatch, changes } = await launchExperiment(user, id, body);
    return jsonOk(
      {
        experiment: {
          id: experiment.id,
          status: experiment.status,
          startedAt: experiment.startedAt,
          caseCount: experiment.caseCount,
          plannedRunCount: experiment.plannedRunCount,
          configSnapshot: experiment.configSnapshot,
        },
        dispatch,
        /** Anything that moved between the saved draft and the sealed config. */
        changes,
      },
      { status: 202 },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
