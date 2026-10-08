import { connection } from "next/server";
import { getHealthReport } from "@/lib/health/health.service";
import { jsonOk } from "@/lib/http/api-response";

/**
 * GET /api/health
 *
 * Route handlers stay thin: parse → delegate to the service → shape response.
 *
 * 200 — every dependency healthy
 * 503 — at least one dependency degraded (body still structured)
 *
 * `connection()` opts out of build-time prerendering/validation passes so the
 * build never touches PostgreSQL or Redis. The payload never contains
 * connection strings, credentials, or env values.
 */
export async function GET(): Promise<Response> {
  await connection();
  const report = await getHealthReport();
  return jsonOk(report, { status: report.status === "healthy" ? 200 : 503 });
}
