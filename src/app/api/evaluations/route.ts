import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readJson, readQuery } from "@/lib/http/request";
import { listBatchesQuerySchema, startEvaluationSchema } from "@/modules/evaluation/evaluation.inputs";
import {
  listEvaluationBatches,
  startEvaluationBatch,
} from "@/modules/evaluation/evaluation.service";

/**
 * GET  /api/evaluations — evaluation batches (filterable by harness/dataset/status)
 * POST /api/evaluations — start a batch: harness version × dataset version × evaluators
 *
 * The batch is created sealed (snapshots) and *then* dispatched, so an HTTP
 * request never executes a single test case.
 */

export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireApiUser();
    const query = listBatchesQuerySchema.parse(Object.fromEntries(readQuery(request)));
    const page = await listEvaluationBatches(user, query);
    return jsonOk(page);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireApiUser();
    const body = startEvaluationSchema.parse(await readJson(request));
    const { batch, dispatch } = await startEvaluationBatch(user, body);
    return jsonOk(
      {
        batch: {
          id: batch.id,
          status: batch.status,
          caseCount: batch.caseCount,
          harnessVersionId: batch.harnessVersionId,
          datasetVersionId: batch.datasetVersionId,
          evaluatorConfig: batch.evaluatorConfig.map((assignment) => ({
            key: assignment.key,
            name: assignment.name,
            kind: assignment.kind,
            weight: assignment.weight,
          })),
          createdAt: batch.createdAt,
        },
        dispatch,
      },
      { status: 202 },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
