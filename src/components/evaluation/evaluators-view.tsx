"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, ChevronRight, Plus, Search, Sparkles } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatRelativeTime } from "@/components/run-status";
import {
  ConfigFieldsEditor,
  coerceRawConfig,
  initialRawConfig,
  type EvaluatorConfigFieldDto,
} from "./evaluator-config-fields";

export interface EvaluatorKindDto {
  kind: string;
  label: string;
  description: string;
  usesLlm: boolean;
  configFields: EvaluatorConfigFieldDto[];
  /** Defaults come from the registry; shape-checked before use. */
  defaultConfig: unknown;
}

function asConfigRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export interface EvaluatorRowDto {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  description: string | null;
  kind: string;
  enabled: boolean;
  currentVersion: number;
  versionCount: number;
  weight: number;
  updatedAt: string;
}

/**
 * Configured evaluators: the reusable scoring procedures a batch pins.
 *
 * The create dialog is driven by the kind registry — its fields, defaults and
 * documentation all come from the server, so a new evaluator kind needs no UI
 * change.
 */
export function EvaluatorsView({
  projects,
  initialEvaluators,
  kinds,
}: {
  projects: { id: string; name: string }[];
  initialEvaluators: EvaluatorRowDto[];
  kinds: EvaluatorKindDto[];
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  const evaluatorsQuery = useQuery({
    queryKey: ["evaluators"],
    queryFn: () => api.get<{ evaluators: EvaluatorRowDto[] }>("/api/evaluators"),
    initialData: { evaluators: initialEvaluators },
  });

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (evaluatorsQuery.data?.evaluators ?? []).filter((row) => {
      if (kindFilter !== "" && row.kind !== kindFilter) {
        return false;
      }
      if (needle === "") {
        return true;
      }
      return row.name.toLowerCase().includes(needle) || row.slug.toLowerCase().includes(needle);
    });
  }, [evaluatorsQuery.data, search, kindFilter]);

  const labelFor = (kind: string): string => kinds.find((entry) => entry.kind === kind)?.label ?? kind;
  const projectName = (projectId: string): string =>
    projects.find((project) => project.id === projectId)?.name ?? "—";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative flex items-center">
            <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search evaluators…"
              data-testid="evaluators-search"
              className="h-8 w-56 pl-8"
            />
          </label>
          <select
            value={kindFilter}
            onChange={(event) => setKindFilter(event.target.value)}
            data-testid="evaluators-kind-filter"
            className="h-8 rounded-md border bg-transparent px-2 text-xs shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
          >
            <option value="">All kinds</option>
            {kinds.map((kind) => (
              <option key={kind.kind} value={kind.kind}>
                {kind.label}
              </option>
            ))}
          </select>
        </div>
        <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={() => setCreateOpen(true)}>
          <Plus className="h-3.5 w-3.5" />
          New evaluator
        </Button>
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-14 text-center">
          <Brain className="h-5 w-5 text-muted-foreground" />
          <p className="text-sm font-medium">No evaluators yet</p>
          <p className="max-w-md text-sm text-muted-foreground">
            An evaluator is a scoring procedure — a deterministic check (exact match, contains,
            JSON schema, tool usage, workflow compliance) or an LLM judge. Configure one, then pick
            it when you start an evaluation.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border" data-testid="evaluators-table">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Evaluator</th>
                <th className="px-4 py-2 font-medium">Kind</th>
                <th className="px-4 py-2 font-medium">Project</th>
                <th className="px-4 py-2 font-medium">Revision</th>
                <th className="px-4 py-2 font-medium">Weight</th>
                <th className="px-4 py-2 font-medium">State</th>
                <th className="px-4 py-2 font-medium">Updated</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const kind = kinds.find((entry) => entry.kind === row.kind);
                return (
                  <tr key={row.id} className="border-b last:border-b-0 hover:bg-muted/30">
                    <td className="px-4 py-2.5">
                      <Link href={`/dashboard/evaluators/${row.id}`} className="text-sm font-medium hover:underline">
                        {row.name}
                      </Link>
                      <p className="mt-0.5 font-mono text-[10.5px] text-muted-foreground">{row.slug}</p>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="inline-flex items-center gap-1 text-xs">
                        {kind?.usesLlm === true ? (
                          <Sparkles className="h-3 w-3 text-violet-500" />
                        ) : null}
                        {labelFor(row.kind)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">{projectName(row.projectId)}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">
                      v{row.currentVersion}
                      <span className="ml-1 text-[10px] text-muted-foreground">/{row.versionCount}</span>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs">
                      {row.weight > 0 ? row.weight.toFixed(2) : "equal"}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={
                          row.enabled
                            ? "rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10.5px] font-medium text-emerald-700 dark:text-emerald-400"
                            : "rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground"
                        }
                      >
                        {row.enabled ? "enabled" : "disabled"}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      {formatRelativeTime(row.updatedAt)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <Button asChild variant="ghost" size="sm" className="h-7 gap-1 text-xs">
                        <Link href={`/dashboard/evaluators/${row.id}`}>
                          Open
                          <ChevronRight className="h-3 w-3" />
                        </Link>
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {createOpen ? (
        <CreateEvaluatorDialog
          projects={projects}
          kinds={kinds}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            void queryClient.invalidateQueries({ queryKey: ["evaluators"] });
          }}
        />
      ) : null}
    </div>
  );
}

function CreateEvaluatorDialog({
  projects,
  kinds,
  onClose,
  onCreated,
}: {
  projects: { id: string; name: string }[];
  kinds: EvaluatorKindDto[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const firstKind = kinds[0];
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [kind, setKind] = useState(firstKind?.kind ?? "");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [weight, setWeight] = useState("0");
  const [raw, setRaw] = useState<Record<string, string>>(
    initialRawConfig(firstKind?.configFields ?? [], asConfigRecord(firstKind?.defaultConfig)),
  );
  const [validation, setValidation] = useState<
    { ok: boolean; issues: { path: string; message: string }[] } | null
  >(null);

  const definition = kinds.find((entry) => entry.kind === kind);

  const check = useMutation({
    mutationFn: async () => {
      const coerced = coerceRawConfig(definition?.configFields ?? [], raw);
      if (!coerced.ok) {
        throw new Error(coerced.error);
      }
      return api.post<{ ok: boolean; issues: { path: string; message: string }[] }>(
        "/api/evaluators/validate",
        { kind, config: coerced.config },
      );
    },
    onSuccess: (result) => setValidation(result),
    onError: (error) =>
      setValidation({ ok: false, issues: [{ path: "(root)", message: errorMessage(error) }] }),
  });

  const create = useMutation({
    mutationFn: async () => {
      const coerced = coerceRawConfig(definition?.configFields ?? [], raw);
      if (!coerced.ok) {
        throw new Error(coerced.error);
      }
      const parsedWeight = Number(weight);
      return api.post<{ evaluator: { id: string } }>("/api/evaluators", {
        projectId,
        name: name.trim(),
        ...(description.trim() !== "" ? { description: description.trim() } : {}),
        kind,
        config: coerced.config,
        ...(Number.isFinite(parsedWeight) ? { weight: parsedWeight } : {}),
      });
    },
    onSuccess: onCreated,
  });

  return (
    <Dialog open onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New evaluator</DialogTitle>
          <DialogDescription>
            The configuration is validated against the evaluator kind before it is saved.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="evaluator-project">Project</Label>
              <select
                id="evaluator-project"
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
                className="h-9 rounded-md border bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="evaluator-kind">Kind</Label>
              <select
                id="evaluator-kind"
                value={kind}
                data-testid="evaluator-kind"
                onChange={(event) => {
                  const nextKind = kinds.find((entry) => entry.kind === event.target.value);
                  setKind(event.target.value);
                  setValidation(null);
                  setRaw(initialRawConfig(nextKind?.configFields ?? [], asConfigRecord(nextKind?.defaultConfig)));
                }}
                className="h-9 rounded-md border bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
              >
                {kinds.map((entry) => (
                  <option key={entry.kind} value={entry.kind}>
                    {entry.label}
                    {entry.usesLlm ? " (judgement)" : ""}
                  </option>
                ))}
              </select>
              {definition !== undefined ? (
                <p className="text-[11px] text-muted-foreground">{definition.description}</p>
              ) : null}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 flex flex-col gap-1.5">
              <Label htmlFor="evaluator-name">Name</Label>
              <Input
                id="evaluator-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Answer exactness"
                data-testid="evaluator-name"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="evaluator-weight">Weight</Label>
              <Input
                id="evaluator-weight"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={weight}
                onChange={(event) => setWeight(event.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">0 = equal weighting.</p>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="evaluator-description">Description</Label>
            <Textarea
              id="evaluator-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={2}
              placeholder="What this check is for."
            />
          </div>

          <div className="rounded-lg border bg-muted/20 p-3">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Configuration
            </p>
            <ConfigFieldsEditor
              fields={definition?.configFields ?? []}
              raw={raw}
              onChange={setRaw}
              idPrefix="new-evaluator"
            />
          </div>

          {validation !== null ? (
            <div
              className={
                validation.ok
                  ? "rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400"
                  : "rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
              }
            >
              {validation.ok ? (
                "Configuration is valid."
              ) : (
                <ul className="list-disc pl-4">
                  {validation.issues.map((issue, index) => (
                    <li key={`${issue.path}-${index}`}>
                      <span className="font-mono">{issue.path}</span>: {issue.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
          {check.isError && validation === null ? (
            <p className="text-xs text-destructive">{errorMessage(check.error)}</p>
          ) : null}
          {create.isError ? (
            <p className="text-xs text-destructive">{errorMessage(create.error)}</p>
          ) : null}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => check.mutate()} disabled={check.isPending}>
            {check.isPending ? "Checking…" : "Check configuration"}
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={create.isPending || projectId === "" || name.trim() === "" || kind === ""}
            data-testid="evaluator-create-submit"
          >
            {create.isPending ? "Creating…" : "Create evaluator"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
