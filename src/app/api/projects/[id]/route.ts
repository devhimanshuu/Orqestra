import { z } from "zod";
import { requireApiUser } from "@/lib/auth/api-session";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { jsonOk } from "@/lib/http/api-response";
import { readJson } from "@/lib/http/request";
import { getProjectDetail, updateProject } from "@/modules/projects/project.service";

/** GET /api/projects/:id — project with its agents and harnesses. */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/projects/[id]">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    return jsonOk(await getProjectDetail(user, id));
  } catch (error) {
    return toErrorResponse(error);
  }
}

const patchProjectBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).nullable().optional(),
});

/** PATCH /api/projects/:id */
export async function PATCH(
  request: Request,
  context: RouteContext<"/api/projects/[id]">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const input = patchProjectBody.parse(await readJson(request));
    return jsonOk({ project: await updateProject(user, id, input) });
  } catch (error) {
    return toErrorResponse(error);
  }
}
