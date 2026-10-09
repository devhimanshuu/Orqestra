import { requireApiUser } from "@/lib/auth/api-session";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { jsonOk } from "@/lib/http/api-response";
import { readQuery } from "@/lib/http/request";
import { runPreviewQuerySchema } from "@/modules/runtime/run.inputs";
import { previewHarnessRun } from "@/modules/runtime/run.service";

/**
 * GET /api/harnesses/:id/run-preview
 *
 * Compiles a published version (or the draft) and reports executability checks,
 * warnings and an execution estimate — the data behind the builder's Run dialog.
 * Read-only: compilation happens here, execution never does.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/harnesses/[id]/run-preview">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const query = runPreviewQuerySchema.parse(Object.fromEntries(readQuery(request)));
    const preview = await previewHarnessRun(user, id, query.harnessVersionId);
    return jsonOk(preview);
  } catch (error) {
    return toErrorResponse(error);
  }
}
