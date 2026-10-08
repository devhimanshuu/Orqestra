import { z } from "zod";
import { requireApiUser } from "@/lib/auth/api-session";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { jsonOk } from "@/lib/http/api-response";
import { readJson } from "@/lib/http/request";
import { getAgentOverview, listAgentVersions, updateAgent } from "@/modules/agents/agent.service";

/** GET /api/agents/:id — overview: latest version, harnesses, run count. */
export async function GET(
  request: Request,
  context: RouteContext<"/api/agents/[id]">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const include = new URL(request.url).searchParams.get("include");

    if (include === "versions") {
      return jsonOk({ versions: await listAgentVersions(user, id) });
    }
    return jsonOk(await getAgentOverview(user, id));
  } catch (error) {
    return toErrorResponse(error);
  }
}

const patchAgentBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  purpose: z.string().trim().max(500).optional(),
  instructions: z.string().trim().min(1, "System instructions are required").max(20_000),
  modelConfig: z.object({
    model: z.string().min(1),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().max(200_000).optional(),
  }),
  capabilities: z.array(z.string().min(1)).max(50).optional(),
});

/** PATCH /api/agents/:id — every edit produces a new immutable AgentVersion. */
export async function PATCH(
  request: Request,
  context: RouteContext<"/api/agents/[id]">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const input = patchAgentBody.parse(await readJson(request));
    return jsonOk(await updateAgent(user, id, input));
  } catch (error) {
    return toErrorResponse(error);
  }
}
