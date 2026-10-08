import { z } from "zod";
import { requireApiUser } from "@/lib/auth/api-session";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { jsonOk } from "@/lib/http/api-response";
import { readJson } from "@/lib/http/request";
import { getHarnessDetail, updateHarness } from "@/modules/harness/harness.service";

const patchHarnessBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  status: z.enum(["ARCHIVED", "DRAFT"]).optional(),
});

/** GET /api/harnesses/:id — harness + draft + current graph + validation + versions. */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/harnesses/[id]">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    return jsonOk(await getHarnessDetail(user, id));
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** PATCH /api/harnesses/:id — rename, describe, archive/restore. */
export async function PATCH(
  request: Request,
  context: RouteContext<"/api/harnesses/[id]">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const input = patchHarnessBody.parse(await readJson(request));
    return jsonOk({ harness: await updateHarness(user, id, input) });
  } catch (error) {
    return toErrorResponse(error);
  }
}
