import { requireApiUser } from "@/lib/auth/api-session";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { jsonOk } from "@/lib/http/api-response";
import { exportHarness } from "@/modules/harness/harness.service";
import { exportHarnessQuerySchema } from "@/modules/harness/harness.inputs";

/**
 * GET /api/harnesses/:id/export[?version=N]
 *
 * Returns a portable document (`orqestra.harness`) that imports into any
 * project. Defaults to the latest published version, or the draft when the
 * harness was never published. The client saves it as
 * `<slug>-v<N>.json` / `<slug>-draft.json`.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/harnesses/[id]/export">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const query = exportHarnessQuerySchema.parse({
      version: new URL(request.url).searchParams.get("version") ?? undefined,
    });
    const result = await exportHarness(user, id, query);
    return jsonOk(
      { fileName: result.fileName, document: result.document },
      {
        headers: {
          "Content-Disposition": `attachment; filename="${result.fileName}"`,
        },
      },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
