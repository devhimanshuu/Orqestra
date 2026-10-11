import { requireApiUser } from "@/lib/auth/api-session";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { jsonOk } from "@/lib/http/api-response";
import { readJson } from "@/lib/http/request";
import { promoteHarnessVersion } from "@/modules/harness/harness.service";
import { promoteVersionSchema } from "@/modules/harness/harness.inputs";

/** POST /api/harnesses/:id/promote — advance the harness to a winning batch's version. */
export async function POST(
  request: Request,
  context: RouteContext<"/api/harnesses/[id]/promote">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const input = promoteVersionSchema.parse(await readJson(request));
    const result = await promoteHarnessVersion(user, id, input);
    return jsonOk(result, { status: 200 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
