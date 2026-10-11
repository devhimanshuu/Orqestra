"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, Sparkles } from "lucide-react";
import { api, errorMessage } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatDuration, formatRelativeTime } from "@/components/run-status";
import { JsonBlock, ScoreBar, StatusChip } from "./shared";

interface RunEvaluationResultDto {
  id: string;
  evaluatorKey: string;
  evaluatorName: string;
  kind: string;
  status: string;
  score: number | null;
  maxScore: number;
  normalizedScore: number | null;
  passed: boolean | null;
  explanation: string;
  evidence: unknown;
  durationMs: number | null;
}

interface RunEvaluationGroupDto {
  batchId: string | null;
  batchLabel: string | null;
  caseKey: string | null;
  caseStatus: string | null;
  runStatus: string | null;
  createdAt: string;
  aggregate: {
    score: number | null;
    status: string;
    passed: boolean | null;
    policy: string;
    explanation: string;
    missing: string[];
    errored: string[];
  } | null;
  results: RunEvaluationResultDto[];
}

interface EvaluatorOption {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  currentVersion: number;
  weight: number;
}

/**
 * "Is this answer good?" — the run-level evaluation panel.
 *
 * A run can be evaluated more than once (a batch, then a re-score after a rubric
 * change), so verdicts are grouped by where they came from. Scoring never
 * touches the run itself.
 */
export function RunEvaluationPanel({ runId, live }: { runId: string; live: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const query = useQuery({
    queryKey: ["run-evaluations", runId],
    queryFn: () => api.get<{ evaluations: RunEvaluationGroupDto[] }>(`/api/runs/${runId}/evaluations`),
  });

  const groups = query.data?.evaluations ?? [];

  return (
    <section className="flex flex-col gap-3 rounded-lg border bg-card p-4" data-testid="run-evaluations">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <FlaskConical className="h-3.5 w-3.5 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Evaluations</h2>
          <span className="text-xs text-muted-foreground">
            scores this run against evaluators — the run itself is never modified
          </span>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1.5 text-xs"
          disabled={live}
          onClick={() => setOpen(true)}
          data-testid="run-evaluate"
          title={live ? "Available once the run finishes" : undefined}
        >
          <Sparkles className="h-3.5 w-3.5" />
          Evaluate this run
        </Button>
      </div>

      {live ? (
        <p className="text-xs text-muted-foreground">
          This run is still executing — evaluate it once it finishes.
        </p>
      ) : null}

      {query.isError ? (
        <p className="text-xs text-destructive">{errorMessage(query.error)}</p>
      ) : groups.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No evaluations yet. A batch evaluation would appear here too, with its case key.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((group, index) => (
            <div key={`${group.batchId ?? "adhoc"}-${group.caseKey ?? index}`} className="rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium">
                  {group.batchId !== null
                    ? `${group.batchLabel ?? `Batch #${group.batchId.slice(-6)}`}${group.caseKey !== null ? ` · case ${group.caseKey}` : ""}`
                    : "One-off evaluation"}
                </span>
                {group.aggregate !== null ? <StatusChip value={group.aggregate.status} kind="aggregate" /> : null}
                {group.aggregate?.passed === true ? (
                  <span className="text-[11px] text-emerald-700 dark:text-emerald-400">passed</span>
                ) : group.aggregate?.passed === false ? (
                  <span className="text-[11px] text-destructive">failed</span>
                ) : null}
                <span className="ml-auto text-[11px] text-muted-foreground">
                  {formatRelativeTime(group.createdAt)}
                </span>
              </div>

              {group.aggregate !== null ? (
                <div className="mt-1.5 flex flex-col gap-1">
                  <ScoreBar value={group.aggregate.score} />
                  <p className="text-[11px] text-muted-foreground">{group.aggregate.explanation}</p>
                  {group.batchId !== null ? (
                    <Link
                      href={`/dashboard/evaluations/${group.batchId}`}
                      className="text-[11px] underline hover:text-foreground"
                    >
                      Open the evaluation batch
                    </Link>
                  ) : null}
                </div>
              ) : null}

              <div className="mt-2 flex flex-col gap-1.5">
                {group.results.map((result) => (
                  <details key={result.id} className="rounded border bg-muted/20 px-2.5 py-2">
                    <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-xs">
                      <span className="font-medium">{result.evaluatorName}</span>
                      <StatusChip value={result.status} kind="result" />
                      <span className="font-mono text-[10.5px] text-muted-foreground">{result.kind}</span>
                      <span className="ml-auto font-mono text-[11px]">
                        {result.score === null ? "no score" : `${result.score}/${result.maxScore}`}
                        {result.durationMs !== null ? ` · ${formatDuration(result.durationMs)}` : ""}
                      </span>
                    </summary>
                    <p className="mt-1.5 text-[11px] text-muted-foreground">{result.explanation}</p>
                    {result.evidence !== null && result.evidence !== undefined ? (
                      <div className="mt-1.5">
                        <JsonBlock value={result.evidence} maxLength={1_800} />
                      </div>
                    ) : null}
                  </details>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {open ? (
        <EvaluateRunDialog
          runId={runId}
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            void queryClient.invalidateQueries({ queryKey: ["run-evaluations", runId] });
          }}
        />
      ) : null}
    </section>
  );
}

function EvaluateRunDialog({
  runId,
  onClose,
  onDone,
}: {
  runId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [policy, setPolicy] = useState<"REQUIRE_ALL" | "IGNORE_MISSING">("REQUIRE_ALL");
  const [threshold, setThreshold] = useState("");

  const evaluatorsQuery = useQuery({
    queryKey: ["evaluators", "enabled"],
    queryFn: () => api.get<{ evaluators: EvaluatorOption[] }>("/api/evaluators?enabledOnly=true"),
  });

  const run = useMutation({
    mutationFn: () => {
      const parsed = threshold.trim() === "" ? null : Number(threshold);
      return api.post(`/api/runs/${runId}/evaluations`, {
        evaluators: selected.map((evaluatorId) => ({ evaluatorId })),
        scoringPolicy: policy,
        ...(parsed !== null && Number.isFinite(parsed) ? { passThreshold: parsed } : {}),
      });
    },
    onSuccess: onDone,
  });

  const evaluators = evaluatorsQuery.data?.evaluators ?? [];

  return (
    <Dialog open onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Evaluate this run</DialogTitle>
          <DialogDescription>
            Pick the evaluators to score this run&apos;s output. Results are stored separately from
            the run — history stays immutable.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {evaluatorsQuery.isLoading ? (
            <p className="text-xs text-muted-foreground">Loading evaluators…</p>
          ) : evaluators.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No enabled evaluators yet.{" "}
              <Link href="/dashboard/evaluators" className="underline hover:text-foreground">
                Configure one
              </Link>
              .
            </p>
          ) : (
            <div className="flex max-h-64 flex-col gap-1.5 overflow-y-auto">
              {evaluators.map((evaluator) => (
                <label
                  key={evaluator.id}
                  className="flex items-center gap-2 rounded-md border px-2.5 py-2 text-xs hover:bg-muted/30"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(evaluator.id)}
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...current, evaluator.id]
                          : current.filter((id) => id !== evaluator.id),
                      )
                    }
                    className="h-3.5 w-3.5 rounded border"
                  />
                  <span className="font-medium">{evaluator.name}</span>
                  <span className="font-mono text-[10.5px] text-muted-foreground">
                    {evaluator.kind} · v{evaluator.currentVersion}
                  </span>
                </label>
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="run-eval-policy" className="text-xs text-muted-foreground">
                Scoring policy
              </label>
              <select
                id="run-eval-policy"
                value={policy}
                onChange={(event) =>
                  setPolicy(event.target.value === "IGNORE_MISSING" ? "IGNORE_MISSING" : "REQUIRE_ALL")
                }
                className="h-9 rounded-md border bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
              >
                <option value="REQUIRE_ALL">Require all evaluators</option>
                <option value="IGNORE_MISSING">Ignore missing scores</option>
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="run-eval-threshold" className="text-xs text-muted-foreground">
                Pass mark (optional)
              </label>
              <input
                id="run-eval-threshold"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={threshold}
                onChange={(event) => setThreshold(event.target.value)}
                className="h-9 rounded-md border bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
              />
            </div>
          </div>

          {run.isError ? <p className="text-xs text-destructive">{errorMessage(run.error)}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => run.mutate()} disabled={run.isPending || selected.length === 0}>
            {run.isPending ? "Evaluating…" : "Evaluate run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
