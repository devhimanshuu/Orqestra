import { requireApiUser } from "@/lib/auth/api-session";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { exportEvaluationReport } from "@/modules/evaluation/evaluation.service";

/**
 * GET /api/evaluations/:id/export
 *
 * A sanitized JSON report: pins, metrics, per-case verdicts and evaluator
 * evidence. Every free-form value is redacted through the same sanitiser the
 * run trace export uses, so a judge's evidence cannot carry a secret out.
 */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/evaluations/[id]/export">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const report = await exportEvaluationReport(user, id);
    return Response.json(report, {
      headers: {
        "Content-Disposition": `attachment; filename="evaluation-${id.slice(-8)}.json"`,
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
