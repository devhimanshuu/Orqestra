import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readJson } from "@/lib/http/request";
import { createExperimentSchema } from "@/modules/experiments/experiment.inputs";
import { planNewExperiment } from "@/modules/experiments/experiment.service";

/**
 * POST /api/experiments/plan — pre-flight an unsaved configuration.
 *
 * Resolves every reference (harness versions, dataset version, evaluator
 * revisions), validates the objective and constraints, estimates the execution
 * volume and cost, and returns the warnings and reproducibility notes the review
 * step shows. Nothing is written and nothing runs, so the wizard can ask as often
 * as the user edits.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireApiUser();
    const body = createExperimentSchema.parse(await readJson(request));
    return jsonOk(await planNewExperiment(user, body));
  } catch (error) {
    return toErrorResponse(error);
  }
}
