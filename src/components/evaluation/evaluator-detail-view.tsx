"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, History, Sparkles, Trash2 } from "lucide-react";
import { api, errorMessage } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
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

export interface EvaluatorVersionDto {
  id: string;
  version: number;
  name: string;
  kind: string;
  description: string | null;
  config: Record<string, unknown>;
  weight: number;
  contentHash: string;
  createdAt: string;
}

export interface EvaluatorDetailDto {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  description: string | null;
  kind: string;
  enabled: boolean;
  currentVersion: number;
  versionCount: number;
  updatedAt: string;
  current: EvaluatorVersionDto;
  versions: EvaluatorVersionDto[];
}

/**
 * Evaluator detail: metadata (mutable) above configuration revisions (immutable).
 *
 * Saving a changed configuration publishes a new revision; the batches that
 * pinned the old one keep meaning what they meant.
 */
export function EvaluatorDetailView({
  initial,
  kindInfo,
}: {
  initial: EvaluatorDetailDto;
  kindInfo: { label: string; description: string; usesLlm: boolean; configFields: EvaluatorConfigFieldDto[] } | null;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const fields = kindInfo?.configFields ?? [];

  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? "");
  const [enabled, setEnabled] = useState(initial.enabled);
  const [raw, setRaw] = useState<Record<string, string>>(
    initialRawConfig(fields, initial.current.config),
  );
  const [weight, setWeight] = useState(String(initial.current.weight));
  const [notice, setNotice] = useState<string | null>(null);
  const [validation, setValidation] = useState<
    { ok: boolean; issues: { path: string; message: string }[] } | null
  >(null);

  const detailQuery = useQuery({
    queryKey: ["evaluator", initial.id],
    queryFn: () =>
      api.get<{ evaluator: EvaluatorDetailDto; versions: EvaluatorVersionDto[] }>(
        `/api/evaluators/${initial.id}`,
      ),
    initialData: { evaluator: initial, versions: initial.versions },
  });
  const evaluator = detailQuery.data.evaluator;
  const versions = detailQuery.data.versions;

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["evaluator", initial.id] });
    void queryClient.invalidateQueries({ queryKey: ["evaluators"] });
    router.refresh();
  };

  const check = useMutation({
    mutationFn: async () => {
      const coerced = coerceRawConfig(fields, raw);
      if (!coerced.ok) {
        throw new Error(coerced.error);
      }
      return api.post<{ ok: boolean; issues: { path: string; message: string }[] }>(
        "/api/evaluators/validate",
        { kind: evaluator.kind, config: coerced.config },
      );
    },
    onSuccess: setValidation,
    onError: (error) =>
      setValidation({ ok: false, issues: [{ path: "(root)", message: errorMessage(error) }] }),
  });

  const saveMeta = useMutation({
    mutationFn: () =>
      api.patch(`/api/evaluators/${initial.id}`, {
        name: name.trim(),
        description: description.trim() === "" ? null : description.trim(),
        enabled,
      }),
    onSuccess: () => {
      setNotice("Details saved.");
      refresh();
    },
  });

  const saveConfig = useMutation({
    mutationFn: async () => {
      const coerced = coerceRawConfig(fields, raw);
      if (!coerced.ok) {
        throw new Error(coerced.error);
      }
      const parsedWeight = Number(weight);
      return api.patch<{ evaluator: EvaluatorDetailDto }>(`/api/evaluators/${initial.id}`, {
        config: coerced.config,
        ...(Number.isFinite(parsedWeight) ? { weight: parsedWeight } : {}),
      });
    },
    onSuccess: (result) => {
      setNotice(
        result.evaluator.currentVersion > initial.currentVersion
          ? `Revision v${result.evaluator.currentVersion} published. Batches pinned to earlier revisions are unchanged.`
          : "Configuration unchanged — no new revision was needed.",
      );
      refresh();
    },
  });

  const remove = useMutation({
    mutationFn: () => api.delete<{ deleted: true }>(`/api/evaluators/${initial.id}`),
    onSuccess: () => router.push("/dashboard/evaluators"),
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{evaluator.name}</h1>
            <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[10.5px] text-muted-foreground">
              v{evaluator.currentVersion}
            </span>
            {kindInfo?.usesLlm === true ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 px-2 py-0.5 text-[10.5px] font-medium text-violet-700 dark:text-violet-400">
                <Sparkles className="h-3 w-3" />
                judgement
              </span>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {kindInfo?.label ?? evaluator.kind} — {kindInfo?.description ?? "Configured scoring procedure."}
          </p>
          <p className="font-mono text-[11px] text-muted-foreground">{evaluator.slug}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs text-destructive hover:text-destructive"
          onClick={() => {
            if (window.confirm(`Delete "${evaluator.name}"? Stored results keep their snapshots.`)) {
              remove.mutate();
            }
          }}
          disabled={remove.isPending}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </Button>
      </div>

      {notice !== null ? (
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{notice}</p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="flex flex-col gap-3 rounded-lg border p-4">
          <h2 className="text-sm font-semibold">Details</h2>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="evaluator-edit-name">Name</Label>
            <Input
              id="evaluator-edit-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="evaluator-edit-description">Description</Label>
            <Textarea
              id="evaluator-edit-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={2}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
              className="h-4 w-4 rounded border"
              data-testid="evaluator-enabled"
            />
            Enabled — disabled evaluators cannot be attached to a batch.
          </label>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={() => saveMeta.mutate()}
              disabled={saveMeta.isPending || name.trim() === ""}
            >
              {saveMeta.isPending ? "Saving…" : "Save details"}
            </Button>
            {saveMeta.isError ? (
              <span className="text-xs text-destructive">{errorMessage(saveMeta.error)}</span>
            ) : null}
          </div>
        </section>

        <section className="flex flex-col gap-3 rounded-lg border p-4">
          <div>
            <h2 className="text-sm font-semibold">Configuration</h2>
            <p className="text-xs text-muted-foreground">
              Saving a change publishes a new immutable revision.
            </p>
          </div>
          <ConfigFieldsEditor
            fields={fields}
            raw={raw}
            onChange={(next) => {
              setRaw(next);
              setValidation(null);
            }}
            idPrefix="evaluator-edit"
          />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="evaluator-edit-weight">Default weight</Label>
            <Input
              id="evaluator-edit-weight"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={weight}
              onChange={(event) => setWeight(event.target.value)}
              className="w-32"
            />
            <p className="text-[11px] text-muted-foreground">0 = equal weighting.</p>
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
          {saveConfig.isError ? (
            <p className="text-xs text-destructive">{errorMessage(saveConfig.error)}</p>
          ) : null}

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={() => check.mutate()}
              disabled={check.isPending}
            >
              {check.isPending ? "Checking…" : "Check configuration"}
            </Button>
            <Button
              size="sm"
              className="h-8 text-xs"
              onClick={() => saveConfig.mutate()}
              disabled={saveConfig.isPending}
              data-testid="evaluator-save-config"
            >
              {saveConfig.isPending ? "Saving…" : "Save configuration"}
            </Button>
          </div>
        </section>
      </div>

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-1.5">
          <History className="h-3.5 w-3.5 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Revision history</h2>
          <span className="text-xs text-muted-foreground">
            {versions.length} revision{versions.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Revision</th>
                <th className="px-3 py-2 font-medium">Weight</th>
                <th className="px-3 py-2 font-medium">Hash</th>
                <th className="px-3 py-2 font-medium">Created</th>
                <th className="px-3 py-2 font-medium">Configuration</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((version) => (
                <tr key={version.id} className="border-b align-top last:border-b-0">
                  <td className="px-3 py-2 font-mono text-xs">v{version.version}</td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {version.weight > 0 ? version.weight.toFixed(2) : "equal"}
                  </td>
                  <td className="px-3 py-2 font-mono text-[10.5px] text-muted-foreground">
                    {version.contentHash.slice(0, 10)}…
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {formatRelativeTime(version.createdAt)}
                  </td>
                  <td className="max-w-96 px-3 py-2">
                    <code className="line-clamp-2 font-mono text-[10.5px] text-muted-foreground">
                      {JSON.stringify(version.config)}
                    </code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          Looking for where this ran?{" "}
          <Link href="/dashboard/evaluations" className="underline hover:text-foreground">
            Open the evaluations list
          </Link>
          .
        </p>
      </section>

      <nav className="flex items-center gap-1 text-xs text-muted-foreground" aria-label="Breadcrumb">
        <Link href="/dashboard/evaluators" className="inline-flex items-center gap-1 hover:text-foreground">
          <ChevronRight className="h-3 w-3 rotate-180" />
          All evaluators
        </Link>
      </nav>
    </div>
  );
}
