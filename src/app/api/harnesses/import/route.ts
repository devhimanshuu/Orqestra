import { requireApiUser } from "@/lib/auth/api-session";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { jsonOk } from "@/lib/http/api-response";
import { readJson } from "@/lib/http/request";
import { importHarness } from "@/modules/harness/harness.service";

/**
 * POST /api/harnesses/import — `{ agentId, document }`.
 * The document is fully revalidated (shape + graph rules) before it becomes a
 * new harness at v1, so an import can never introduce an invalid harness.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireApiUser();
    const input = await readJson(request);
    const created = await importHarness(user, input);
    return jsonOk(created, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
