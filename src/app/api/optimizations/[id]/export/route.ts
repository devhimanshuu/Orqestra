import { requireApiUser } from "@/lib/auth/api-session";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readQuery } from "@/lib/http/request";
import { exportOptimizationReportSchema } from "@/modules/optimization/optimization.inputs";
import { exportOptimizationReport } from "@/modules/optimization/optimization.service";

/**
 * GET /api/optimizations/:id/export?format=json|markdown
 *
 * The optimization report: the sealed frame, every finding with its evidence, the
 * hypotheses, each candidate's typed changes and measured outcome, the acceptance
 * verdicts and the recommendation. Free-form values pass through the shared
 * sanitiser, so nothing a model or a tool produced can carry a credential out of
 * the platform.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/optimizations/[id]/export">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const query = exportOptimizationReportSchema.parse(Object.fromEntries(readQuery(request)));
    const report = await exportOptimizationReport(user, id, query);
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
