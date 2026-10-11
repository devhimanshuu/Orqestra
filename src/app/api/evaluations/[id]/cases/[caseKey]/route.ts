import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import {
  getEvaluationCase,
  retryEvaluationCase,
} from "@/modules/evaluation/evaluation.service";

/**
 * GET  /api/evaluations/:id/cases/:caseKey — one case with every evaluator verdict
 * POST /api/evaluations/:id/cases/:caseKey — retry a failed/cancelled case
 *
 * Retrying re-runs the *same* pinned harness version and dataset case through
 * the ordinary runtime, then upserts the verdicts (so a retry cannot produce
 * duplicate scores).
 */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/evaluations/[id]/cases/[caseKey]">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id, caseKey } = await context.params;
    const result = await getEvaluationCase(user, id, caseKey);
    return jsonOk({
      case: result.case,
      results: result.results,
      passed: result.passed,
      scoringPolicy: result.batch.scoringPolicy,
      passThreshold: result.batch.passThreshold,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(
  _request: Request,
  context: RouteContext<"/api/evaluations/[id]/cases/[caseKey]">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id, caseKey } = await context.params;
    const row = await retryEvaluationCase(user, id, caseKey);
    return jsonOk({ case: row }, { status: 202 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
