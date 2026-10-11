import { requireApiUser } from "@/lib/auth/api-session";
import { jsonOk } from "@/lib/http/api-response";
import { toErrorResponse } from "@/lib/http/error-mapper";
import { readQuery } from "@/lib/http/request";
import { compareBatchesQuerySchema } from "@/modules/evaluation/evaluation.inputs";
import { compareEvaluationBatches } from "@/modules/evaluation/evaluation.service";

/**
 * GET /api/evaluations/compare?baseline=<id>&candidate=<id>[&includeCases=true]
 *
 * Aligns two batches by stable test-case id and reports improvements,
 * regressions and metric deltas. Batches from different datasets are refused
 * (409) rather than compared as if their cases were equivalent.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const user = await requireApiUser();
    const query = compareBatchesQuerySchema.parse(Object.fromEntries(readQuery(request)));
    const comparison = await compareEvaluationBatches(user, query);
    return jsonOk({
      baseline: {
        id: comparison.baseline.id,
        label: comparison.baseline.label,
        harnessVersionLabel: comparison.baseline.harnessVersionLabel,
        status: comparison.baseline.status,
      },
      candidate: {
        id: comparison.candidate.id,
        label: comparison.candidate.label,
        harnessVersionLabel: comparison.candidate.harnessVersionLabel,
        status: comparison.candidate.status,
      },
      compatible: comparison.compatible,
      sameDatasetVersion: comparison.sameDatasetVersion,
      sameHarnessVersion: comparison.sameHarnessVersion,
      alignment: comparison.alignment,
      metrics: comparison.metrics,
      regressions: comparison.regressions,
      improvements: comparison.improvements,
      unchanged: comparison.unchanged,
      caseMovements: query.includeCases ? comparison.caseMovements : undefined,
      summary: comparison.summary,
      baselineHarness: {
        id: comparison.baselineBatch.harnessId,
        versionId: comparison.baselineBatch.harnessVersionId,
        version: comparison.baselineBatch.harnessSnapshot.harnessVersion,
        name: comparison.baselineBatch.harnessSnapshot.harnessName,
        passRate: comparison.baselineBatch.metrics?.passRate ?? null,
        passThreshold: comparison.baselineBatch.passThreshold,
        status: comparison.baselineBatch.status,
      },
      candidateHarness: {
        id: comparison.candidateBatch.harnessId,
        versionId: comparison.candidateBatch.harnessVersionId,
        version: comparison.candidateBatch.harnessSnapshot.harnessVersion,
        name: comparison.candidateBatch.harnessSnapshot.harnessName,
        passRate: comparison.candidateBatch.metrics?.passRate ?? null,
        passThreshold: comparison.candidateBatch.passThreshold,
        status: comparison.candidateBatch.status,
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
