import { z } from "zod";
import { requireApiUser } from "@/lib/auth/api-session";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { jsonOk } from "@/lib/http/api-response";
import { readJson } from "@/lib/http/request";
import { saveHarnessDraft } from "@/modules/harness/harness.service";

/**
 * Drafts are autosaved here — never a version. The draft document is validated
 * server-side: the shape must be well-formed (node types, positions, edge
 * references), while the *graph* may still be incomplete or invalid, in which
 * case the harness is marked INVALID and the issues are returned to the editor.
 */
const draftBody = z.object({
  definition: z.unknown(),
});

/** PUT /api/harnesses/:id/draft */
export async function PUT(
  request: Request,
  context: RouteContext<"/api/harnesses/[id]/draft">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const input = draftBody.parse(await readJson(request));
    const { draft, validation, status } = await saveHarnessDraft(user, id, input);
    return jsonOk({
      draft: { harnessId: draft.harnessId, updatedAt: draft.updatedAt },
      status,
      validation: { ok: validation.ok, issues: validation.ok ? [] : validation.issues },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
