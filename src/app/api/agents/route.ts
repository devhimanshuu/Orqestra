import { z } from "zod";
import { requireApiUser } from "@/lib/auth/api-session";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { jsonOk } from "@/lib/http/api-response";
import { readJson } from "@/lib/http/request";
import { createAgent, listAgents } from "@/modules/agents/agent.service";

const createAgentBody = z.object({
  projectId: z.string().min(1),
  name: z.string().trim().min(1, "Name is required").max(80),
  description: z.string().trim().max(500).optional(),
  purpose: z.string().trim().max(500).optional(),
  slug: z.string().trim().max(60).optional(),
  instructions: z.string().trim().min(1, "System instructions are required").max(20_000),
  modelConfig: z.object({
    model: z.string().min(1),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().max(200_000).optional(),
  }),
  capabilities: z.array(z.string().min(1)).max(50).optional(),
});

/** GET /api/agents?projectId=… */
export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireApiUser();
    const projectId = new URL(request.url).searchParams.get("projectId");
    if (projectId === null) {
      return jsonOk({ agents: [] });
    }
    return jsonOk({ agents: await listAgents(user, projectId) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** POST /api/agents */
export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { projectId, ...input } = createAgentBody.parse(await readJson(request));
    const created = await createAgent(user, projectId, input);
    return jsonOk(created, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
