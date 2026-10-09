import { requireApiUser } from "@/lib/auth/api-session";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { jsonOk } from "@/lib/http/api-response";
import { getRunDetail } from "@/modules/runtime/run.service";

/** GET /api/runs/:id — run + steps + events + usage, scoped to the caller. */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/runs/[id]">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const detail = await getRunDetail(user, id);
    return jsonOk({
      run: detail.run,
      steps: detail.steps,
      events: detail.events,
      usage: detail.usage,
      usageTotal: detail.usageTotal,
      harness: detail.harness,
      harnessVersionLabel: detail.harnessVersionLabel,
      agent: detail.agent,
      live: detail.live,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
