import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readJson, readQuery } from "@/lib/http/request";
import {
  createOptimizationSessionSchema,
  listOptimizationSessionsQuerySchema,
} from "@/modules/optimization/optimization.inputs";
import {
  createOptimizationSession,
  listOptimizationSessions,
} from "@/modules/optimization/optimization.service";

/**
 * GET  /api/optimizations — sessions the caller may see (search/filter/paginate)
 * POST /api/optimizations — create a DRAFT from resolved, immutable references
 *
 * Creating never executes anything: the draft pins a baseline harness version and
 * the evaluation batch that produced its evidence, and pre-flight validation runs
 * before a single row is written. Starting the loop is a separate, explicitly
 * confirmed call.
 */

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireApiUser();
    const query = listOptimizationSessionsQuerySchema.parse(Object.fromEntries(readQuery(request)));
    return jsonOk(await listOptimizationSessions(user, query));
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireApiUser();
    const body = createOptimizationSessionSchema.parse(await readJson(request));
    const detail = await createOptimizationSession(user, body);
    return jsonOk(
      {
        session: {
          id: detail.session.id,
          name: detail.session.name,
          status: detail.session.status,
          agentId: detail.session.agentId,
          harnessId: detail.session.harnessId,
          baselineVersionId: detail.session.baselineVersionId,
          sourceBatchId: detail.session.sourceBatchId,
          datasetId: detail.session.datasetId,
          datasetVersionId: detail.session.datasetVersionId,
          objective: detail.session.objective,
          constraints: detail.session.constraints,
          limits: detail.session.limits,
          requireApproval: detail.session.requireApproval,
          createdAt: detail.session.createdAt,
        },
        progress: detail.progress,
      },
      { status: 201 },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
