import { requireApiUser } from "@/lib/auth/api-session";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { jsonOk } from "@/lib/http/api-response";
import { readJson } from "@/lib/http/request";
import { harnessDraftDocumentSchema } from "@/modules/harness/harness.schema";
import { validateHarnessForUser } from "@/modules/harness/harness.service";

/**
 * POST /api/harnesses/:id/validate — runs the authoritative validation rules
 * on a definition without persisting anything. The editor uses this to confirm
 * client-side results; publishing revalidates anyway.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/harnesses/[id]/validate">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const body = harnessDraftDocumentSchema.parse(await readJson(request));
    const result = await validateHarnessForUser(user, id, { definition: body });
    return jsonOk({
      ok: result.ok,
      issues: result.ok ? [] : result.issues,
      stats: result.ok
        ? { nodes: result.definition.nodes.length, edges: result.definition.edges.length }
        : null,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
