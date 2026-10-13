import { requireApiUser } from "@/lib/auth/api-session";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readQuery } from "@/lib/http/request";
import { exportExperimentQuerySchema } from "@/modules/experiments/experiment.inputs";
import { exportExperiment } from "@/modules/experiments/experiment.service";

/**
 * GET /api/experiments/:id/export?format=json|csv
 *
 * The experiment report: the sealed configuration snapshot, every candidate's
 * metrics, constraints, ranking reasons and per-case verdicts. Every free-form
 * value passes through the shared sanitiser, so a stored error or an evaluator's
 * evidence (which may quote agent output) cannot carry a credential out of the
 * platform.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/experiments/[id]/export">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const query = exportExperimentQuerySchema.parse(Object.fromEntries(readQuery(request)));
    const report = await exportExperiment(user, id, query);
    return new Response(report.body, {
      headers: {
        "content-type": report.contentType,
        "content-disposition": `attachment; filename="${report.fileName}"`,
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
