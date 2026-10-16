"use client";

import Link from "next/link";
import { ArrowLeft, Info, Layers, Sparkles, TrendingUp } from "lucide-react";
import { categoryLabel } from "@/modules/optimization/analysis/failure-analysis";
import type {
  FailureCategoryEffectiveness,
  MutationOperationEffectiveness,
  OptimizationHistory,
  StrategyEffectiveness,
} from "@/modules/optimization/history/history";
import type { FailureCategory } from "@/modules/optimization/optimization.types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";

/**
 * Optimization history.
 *
 * Answers the cross-session question: which mutation strategies actually work,
 * per weakness? Every figure comes from stored rows, and the view is explicit
 * about the two things that are easy to fake:
 *
 *  - a rate over zero candidates renders as "—", never "0%";
 *  - a mean improvement states the metric it is in, and says when measured
 *    candidates on other metrics were left out of it.
 */

const STRATEGY_LABELS: Record<string, string> = {
  RULE_BASED: "Rule-based",
  LLM_ASSISTED: "LLM-assisted",
  MANUAL: "Manual",
};

const METRIC_LABELS: Record<string, string> = {
  evaluation_score: "evaluation score",
  pass_rate: "pass rate",
  failure_rate: "failure rate",
  median_latency_ms: "median latency (ms)",
  p95_latency_ms: "p95 latency (ms)",
  average_total_tokens: "avg tokens",
  total_tokens: "total tokens",
  estimated_cost_usd: "estimated cost (USD)",
  tool_calls_per_case: "tool calls per case",
};

const EVIDENCE_STYLES: Record<string, string> = {
  established: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20 dark:text-emerald-400",
  suggestive: "bg-amber-500/10 text-amber-600 border-amber-500/20 dark:text-amber-400",
  insufficient: "bg-muted text-muted-foreground border-border",
};

const EVIDENCE_HELP: Record<string, string> = {
  established: "Eight or more measured candidate comparisons back this category.",
  suggestive: "Three to seven measured comparisons — a lead, not a result.",
  insufficient: "Fewer than three measured comparisons; treat every figure as an observation.",
};

function asPercent(value: number | null, digits = 1): string {
  return value === null ? "—" : `${(value * 100).toFixed(digits)}%`;
}

function asSignedPercent(value: number | null, digits = 1): string {
  if (value === null) {
    return "—";
  }
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(digits)}%`;
}

/** A raw metric movement: small numbers keep their precision, large ones don't. */
function asMetric(value: number | null): string {
  if (value === null) {
    return "—";
  }
  const magnitude = Math.abs(value);
  if (magnitude === 0) {
    return "0";
  }
  return magnitude >= 100 ? value.toFixed(1) : magnitude >= 1 ? value.toFixed(2) : value.toFixed(4);
}

function metricLabel(metric: string | null): string {
  return metric === null ? "unmeasured" : (METRIC_LABELS[metric] ?? metric);
}

function strategyLabel(strategy: string): string {
  return STRATEGY_LABELS[strategy] ?? strategy;
}

function EvidenceChip({ evidence }: { evidence: string }) {
  return (
    <Badge
      variant="outline"
      className={cn("text-[10.5px] font-medium", EVIDENCE_STYLES[evidence] ?? EVIDENCE_STYLES["insufficient"])}
      title={EVIDENCE_HELP[evidence] ?? ""}
      data-testid={`history-evidence-${evidence}`}
    >
      {evidence}
    </Badge>
  );
}

function StatTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-card px-4 py-3">
      <p className="text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Th({ children, align = "right" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      scope="col"
      className={cn(
        "whitespace-nowrap px-2 py-1.5 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground",
        align === "left" ? "text-left" : "text-right",
      )}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = "right",
  className,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <td
      className={cn(
        "whitespace-nowrap px-2 py-1.5 tabular-nums",
        align === "left" ? "text-left" : "text-right",
        className,
      )}
    >
      {children}
    </td>
  );
}

/** One strategy's record inside a category — the comparison the view exists for. */
function StrategyTable({ rows }: { rows: StrategyEffectiveness[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No candidate has been proposed for this weakness yet.
      </p>
    );
  }
  return (
    // `contain: inline-size` is what actually keeps a wide table inside this
    // box: `overflow-x-auto` alone still reports the table's min-content width
    // to the flex chain above it, which stretches the whole page at narrow
    // viewports instead of scrolling the table.
    <div className="min-w-0 overflow-x-auto [contain:inline-size]">
      <table className="w-full min-w-[46rem] border-collapse text-xs">
        <caption className="sr-only">
          Mutation strategy effectiveness for this failure category
        </caption>
        <thead>
          <tr className="border-b border-border/60">
            <Th align="left">Strategy</Th>
            <Th>Sessions</Th>
            <Th>Candidates</Th>
            <Th>Evaluated</Th>
            <Th>Accepted</Th>
            <Th>Rejected</Th>
            <Th>Invalid</Th>
            <Th>Accept rate</Th>
            <Th>Mean improvement</Th>
            <Th>Mean relative</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.strategy}
              className="border-b border-border/40 last:border-0"
              data-testid={`history-strategy-${row.strategy}`}
            >
              <Td align="left" className="font-medium">
                {strategyLabel(row.strategy)}
              </Td>
              <Td>{row.sessions}</Td>
              <Td>{row.candidates}</Td>
              <Td>{row.evaluated}</Td>
              <Td>{row.accepted}</Td>
              <Td>{row.rejected}</Td>
              <Td>{row.invalid}</Td>
              <Td>{asPercent(row.acceptanceRate)}</Td>
              <Td>
                {asMetric(row.meanImprovement)}
                {row.measured > 0 && (
                  <span className="ml-1 text-[10.5px] text-muted-foreground">
                    / {metricLabel(row.metric)}
                  </span>
                )}
              </Td>
              <Td>{asSignedPercent(row.meanRelativeImprovement)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Which exact changes were tried, and how they fared. */
function OperationTable({ rows }: { rows: MutationOperationEffectiveness[] }) {
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">No mutation was recorded for this weakness.</p>;
  }
  return (
    <div className="min-w-0 overflow-x-auto [contain:inline-size]">
      <table className="w-full min-w-[30rem] border-collapse text-xs">
        <caption className="sr-only">Mutation operations used and their outcomes</caption>
        <thead>
          <tr className="border-b border-border/60">
            <Th align="left">Operation</Th>
            <Th>Candidates</Th>
            <Th>Accepted</Th>
            <Th>Rejected</Th>
            <Th>Invalid</Th>
            <Th>Accept rate</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.operation} className="border-b border-border/40 last:border-0">
              {/* Operation discriminators are stable identifiers, so they stay monospaced. */}
              <Td align="left" className="font-mono text-[11px]">
                {row.operation}
              </Td>
              <Td>{row.candidates}</Td>
              <Td>{row.accepted}</Td>
              <Td>{row.rejected}</Td>
              <Td>{row.invalid}</Td>
              <Td>{asPercent(row.acceptanceRate)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CategoryCard({ entry }: { entry: FailureCategoryEffectiveness }) {
  const best = entry.byStrategy.find((row) => row.strategy === entry.bestStrategy) ?? null;
  return (
    <Card data-testid={`history-category-${entry.category}`} className="min-w-0">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardTitle className="flex items-center gap-2 text-base">
              {categoryLabel(entry.category as FailureCategory)}
              <EvidenceChip evidence={entry.evidence} />
            </CardTitle>
            <CardDescription className="text-xs">
              Observed in {entry.findings} finding(s) across {entry.sessions} session(s) ·{" "}
              {entry.hypotheses} hypothesis(es) proposed · {entry.candidates} candidate(s)
            </CardDescription>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <p>
              Accept rate{" "}
              <span className="font-medium text-foreground">{asPercent(entry.acceptanceRate)}</span>
              <span className="ml-1">({entry.accepted}/{entry.evaluated} evaluated)</span>
            </p>
            <p className="mt-0.5">
              Mean improvement{" "}
              <span className="font-medium text-foreground">
                {asSignedPercent(entry.meanRelativeImprovement)}
              </span>
              {entry.measured > 0 && (
                <span className="ml-1">
                  on {metricLabel(entry.metric)} ({entry.measured} measured
                  {entry.measuredExcluded > 0 ? `, ${entry.measuredExcluded} excluded` : ""})
                </span>
              )}
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        {best !== null ? (
          <p className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs">
            <TrendingUp className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            <span>
              <span className="font-medium">Best measured: {strategyLabel(best.strategy)}.</span>{" "}
              Mean {asSignedPercent(best.meanRelativeImprovement)} on {metricLabel(best.metric)} over{" "}
              {best.measured} measured candidate(s). Improvement is observed, not established —{" "}
              {EVIDENCE_HELP[entry.evidence]?.toLowerCase() ?? ""}
            </span>
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            No candidate for this weakness has a comparable baseline measurement, so no strategy can be
            compared on improvement yet. The rates above are still policy outcomes.
          </p>
        )}

        <section className="flex min-w-0 flex-col gap-2">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold">
            <Layers className="h-3.5 w-3.5 text-muted-foreground" />
            Mutation strategy effectiveness
          </h3>
          <StrategyTable rows={entry.byStrategy} />
        </section>

        <section className="flex min-w-0 flex-col gap-2">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold">
            <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
            Mutations tried
          </h3>
          <OperationTable rows={entry.operations} />
        </section>
      </CardContent>
    </Card>
  );
}

export function HistoryView({ history }: { history: OptimizationHistory }) {
  const { totals, filters } = history;
  const scoped = filters.projectId !== null || filters.agentId !== null || filters.since !== null;

  return (
    <div
      className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-6 px-6 py-10"
      data-testid="optimization-history"
    >
      <PageHeader
        title="Optimization history"
        description="How each mutation strategy has actually performed across sessions, grouped by the weakness it targeted. Derived from stored candidates — an unmeasured value is shown as “—”, never as zero."
        actions={
          <Button asChild variant="outline" size="sm" className="gap-1.5">
            <Link href="/dashboard/optimizations">
              <ArrowLeft className="h-3.5 w-3.5" />
              All sessions
            </Link>
          </Button>
        }
      />

      {scoped && (
        <p className="text-xs text-muted-foreground">
          Scoped to{" "}
          {filters.projectId !== null && <span className="font-mono">{filters.projectId}</span>}
          {filters.agentId !== null && (
            <>
              {filters.projectId !== null ? ", " : ""}
              agent <span className="font-mono">{filters.agentId}</span>
            </>
          )}
          {filters.since !== null && (
            <>
              {(filters.projectId !== null || filters.agentId !== null) ? ", " : ""}
              sessions since {new Date(filters.since).toLocaleDateString()}
            </>
          )}
          {" · "}
          <Link href="/dashboard/optimizations/history" className="text-primary hover:underline">
            clear
          </Link>
        </p>
      )}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="history-totals">
        <StatTile
          label="Sessions"
          value={totals.sessions.toLocaleString()}
          hint={`${totals.settledSessions} settled · ${totals.sessionsWithFindings} with findings`}
        />
        <StatTile
          label="Candidates evaluated"
          value={totals.evaluated.toLocaleString()}
          hint={`${totals.candidates} proposed in total`}
        />
        <StatTile
          label="Accepted / rejected"
          value={`${totals.accepted} / ${totals.rejected}`}
          hint={`${totals.invalid} rejected as invalid before evaluation`}
        />
        <StatTile
          label="Measured comparisons"
          value={totals.measuredComparisons.toLocaleString()}
          hint={
            totals.measuredComparisons === 0
              ? "No candidate has a comparable baseline yet"
              : "Candidates with both a baseline and a measured result"
          }
        />
      </section>

      <section className="rounded-xl border border-border/70 bg-muted/20 px-4 py-3">
        <h2 className="flex items-center gap-1.5 text-xs font-semibold">
          <Info className="h-3.5 w-3.5 text-muted-foreground" />
          What this history does and does not prove
        </h2>
        <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-[11.5px] leading-relaxed text-muted-foreground">
          {history.notes.map((note) => (
            <li key={note} data-testid="history-note">
              {note}
            </li>
          ))}
        </ul>
      </section>

      {history.categories.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="No optimization history yet"
          description="Once optimization sessions have analysed an evaluation and evaluated candidates, their outcomes are compared here by weakness and strategy."
          action={
            <Button asChild size="sm">
              <Link href="/dashboard/optimizations">Go to optimizations</Link>
            </Button>
          }
          data-testid="history-empty"
        />
      ) : (
        <div className="flex min-w-0 flex-col gap-6">
          {history.categories.map((entry) => (
            <CategoryCard key={entry.category} entry={entry} />
          ))}
        </div>
      )}

      {history.unattributed !== null && (
        <Card data-testid="history-unattributed" className="min-w-0">
          <CardHeader>
            <CardTitle className="text-base">Candidates without a failure category</CardTitle>
            <CardDescription className="text-xs">
              Manual and LLM-assisted candidates test no hypothesis, so they are reported here rather
              than credited to a weakness they were never aimed at.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex min-w-0 flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              {history.unattributed.candidates} candidate(s) across{" "}
              {history.unattributed.sessions} session(s) · {history.unattributed.accepted} accepted ·{" "}
              {history.unattributed.rejected} rejected · {history.unattributed.invalid} invalid
            </p>
            <OperationTable rows={history.unattributed.operations} />
          </CardContent>
        </Card>
      )}

      <p className="text-[11px] text-muted-foreground">
        Generated {new Date(history.generatedAt).toLocaleString()}.
      </p>
    </div>
  );
}
