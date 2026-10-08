import { z } from "zod";
import { requireApiUser } from "@/lib/auth/api-session";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { jsonOk } from "@/lib/http/api-response";
import { readJson } from "@/lib/http/request";
import { duplicateHarness } from "@/modules/harness/harness.service";

const duplicateBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  sourceVersionId: z.string().min(1).optional(),
});

/** POST /api/harnesses/:id/duplicate — copies the graph into a new harness at v1. */
export async function POST(
  request: Request,
  context: RouteContext<"/api/harnesses/[id]/duplicate">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const input = duplicateBody.parse(await readJson(request));
    const created = await duplicateHarness(user, id, input);
    return jsonOk(created, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
