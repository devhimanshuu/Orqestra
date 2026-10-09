import { requireApiUser } from "@/lib/auth/api-session";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { jsonOk } from "@/lib/http/api-response";
import { readJson, readQuery } from "@/lib/http/request";
import { createRunSchema, listRunsQuerySchema } from "@/modules/runtime/run.inputs";
import { createRun, listRuns } from "@/modules/runtime/run.service";

/**
 * GET  /api/runs — paginated run history (status / harness / agent / date filters)
 * POST /api/runs — create + queue a run (never executes in the request)
 */

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireApiUser();
    const query = listRunsQuerySchema.parse(Object.fromEntries(readQuery(request)));
    const page = await listRuns(user, query);
    return jsonOk({
      runs: page.runs,
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireApiUser();
    const body = createRunSchema.parse(await readJson(request));
    const { run, dispatch } = await createRun(user, body);
    return jsonOk(
      {
        run: {
          id: run.id,
          status: run.status,
          harnessId: run.harnessId,
          harnessVersionId: run.harnessVersionId,
          agentId: run.agentId,
          attempt: run.attempt,
          createdAt: run.createdAt,
          metadata: run.metadata,
        },
        dispatch,
      },
      { status: 202 },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
