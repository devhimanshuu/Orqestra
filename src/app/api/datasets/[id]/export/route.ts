import { requireApiUser } from "@/lib/auth/api-session";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readQuery } from "@/lib/http/request";
import { exportDatasetQuerySchema } from "@/modules/evaluation/dataset.inputs";
import { exportDataset } from "@/modules/evaluation/dataset.service";

/**
 * GET /api/datasets/:id/export[?version=N]
 *
 * Returns the portable `orqestra.dataset` document. Without `version` it
 * exports the working set; with one, an exact published snapshot — so an
 * exported file can reproduce a specific evaluation's corpus.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/datasets/[id]/export">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const query = exportDatasetQuerySchema.parse(Object.fromEntries(readQuery(request)));
    const document = await exportDataset(user, id, query);
    return Response.json(document, {
      headers: {
        "Content-Disposition": `attachment; filename="${document.dataset.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/(^-|-$)/g, "")}-v${document.dataset.version}.json"`,
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
