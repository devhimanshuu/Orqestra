import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readJson } from "@/lib/http/request";
import { startOptimizationSessionSchema } from "@/modules/optimization/optimization.inputs";
import { startOptimizationSession } from "@/modules/optimization/optimization.service";

/**
 * POST /api/optimizations/:id/start
 *
 * Seals the session on first call (the baseline version, evidence batch, dataset
 * version, evaluator revisions, objective, constraints and ceilings are written
 * once) and dispatches a pass. The same call resumes a session that is queued,
 * running after a crash, or parked for review — the pass claims the session
 * atomically, so a resume can neither double-run nor lose an approved candidate.
 *
 * The body must carry `confirm: true`: starting spends real runs.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/optimizations/[id]/start">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    startOptimizationSessionSchema.parse(await readJson(request));
    const result = await startOptimizationSession(user, id);
    return jsonOk({
      session: {
        id: result.session.id,
        status: result.session.status,
        startedAt: result.session.startedAt,
        configSnapshot: result.session.configSnapshot,
      },
      dispatch: result.dispatch,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
