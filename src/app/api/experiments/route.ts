import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readJson, readQuery } from "@/lib/http/request";
import { createExperimentSchema, listExperimentsQuerySchema } from "@/modules/experiments/experiment.inputs";
import { createExperiment, listExperiments } from "@/modules/experiments/experiment.service";

/**
 * GET  /api/experiments — experiments the caller may see (search/filter/paginate)
 * POST /api/experiments — create a DRAFT from resolved, immutable references
 *
 * Creating never executes anything: the draft pins a baseline harness version,
 * candidate harness versions, a dataset version and evaluator revisions, and
 * pre-flight validation runs before a single row is written. Launching is a
 * separate, explicitly confirmed call.
 */

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireApiUser();
    const query = listExperimentsQuerySchema.parse(Object.fromEntries(readQuery(request)));
    const page = await listExperiments(user, query);
    return jsonOk(page);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireApiUser();
    const body = createExperimentSchema.parse(await readJson(request));
    const experiment = await createExperiment(user, body);
    return jsonOk(
      {
        experiment: {
          id: experiment.id,
          name: experiment.name,
          status: experiment.status,
          agentId: experiment.agentId,
          datasetId: experiment.datasetId,
          datasetVersionId: experiment.datasetVersionId,
          caseCount: experiment.caseCount,
          plannedRunCount: experiment.plannedRunCount,
          objective: experiment.objective,
          constraints: experiment.constraints,
          execution: experiment.execution,
          createdAt: experiment.createdAt,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
