import { z } from "zod";
import { requireApiUser } from "@/lib/auth/api-session";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { jsonOk } from "@/lib/http/api-response";
import { readJson } from "@/lib/http/request";
import { assertAgentAccess } from "@/modules/access/access.service";
import { harnessRepository } from "@/modules/harness/harness.repository";
import { createHarness } from "@/modules/harness/harness.service";

const createHarnessBody = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  description: z.string().trim().max(500).optional(),
  slug: z.string().trim().max(60).optional(),
});

/** GET /api/agents/:id/harnesses */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/agents/[id]/harnesses">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const agent = await assertAgentAccess(user.id, id);
    return jsonOk({ harnesses: await harnessRepository.listByAgent(agent.id) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** POST /api/agents/:id/harnesses — creates the harness with a valid v1 graph. */
export async function POST(
  request: Request,
  context: RouteContext<"/api/agents/[id]/harnesses">,
): Promise<Response> {
  try {
    const user = await requireApiUser();
    const { id } = await context.params;
    const input = createHarnessBody.parse(await readJson(request));
    const created = await createHarness(user, id, input);
    return jsonOk(created, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
