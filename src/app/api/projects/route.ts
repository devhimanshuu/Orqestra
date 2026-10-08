import { z } from "zod";
import { requireApiUser } from "@/lib/auth/api-session";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { jsonOk } from "@/lib/http/api-response";
import { readJson } from "@/lib/http/request";
import { createProject, listProjects } from "@/modules/projects/project.service";

/** GET /api/projects — the signed-in user's projects. */
export async function GET(): Promise<Response> {
  try {
    const user = await requireApiUser();
    return jsonOk({ projects: await listProjects(user) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

const createProjectBody = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  description: z.string().trim().max(500).optional(),
  slug: z.string().trim().max(60).optional(),
});

/** POST /api/projects */
export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireApiUser();
    const input = createProjectBody.parse(await readJson(request));
    const project = await createProject(user, input);
    return jsonOk({ project }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
