import { z } from "zod";
import { requireApiUser } from "@/lib/auth/api-session";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { jsonOk } from "@/lib/http/api-response";
import { readJson } from "@/lib/http/request";
import { listHarnessVersions, publishHarnessVersion } from "@/modules/harness/harness.service";

const publishBody = z.object({
  releaseNotes: z.string().trim().max(1000).optional(),
});

/** GET /api/harnesses/:id/versions — newest first. */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/harnesses/[id]/versions">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    return jsonOk({ versions: await listHarnessVersions(user, id) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/**
 * POST /api/harnesses/:id/versions — publishes an immutable version from the
 * current draft (or an explicitly supplied definition).
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/harnesses/[id]/versions">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const input = publishBody.parse(await readJson(request));
    const result = await publishHarnessVersion(user, id, input);
    return jsonOk(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
