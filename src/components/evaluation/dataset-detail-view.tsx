"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Pencil, Plus, Trash2, Upload } from "lucide-react";
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
import { parseJsonField } from "./shared";

export interface DatasetCaseDto {
  id: string;
  caseKey: string;
  name: string | null;
  input: unknown;
  expectedOutput: unknown;
  metadata: unknown;
  tags: string[];
  updatedAt: string;
}

export interface DatasetVersionDto {
  id: string;
  version: number;
  name: string;
  caseCount: number;
  contentHash: string;
  createdAt: string;
}

export interface DatasetDetailDto {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  description: string | null;
  currentVersion: number;
  caseCount: number;
  cases: DatasetCaseDto[];
  versions: DatasetVersionDto[];
}

type DatasetDetailResponse = DatasetDetailDto;

/**
 * Dataset detail: the working set (editable) above the immutable versions.
 *
 * Editing a case never touches a published version — publishing is an explicit
 * action, and publishing an unchanged corpus returns the existing version. That
 * separation is what makes "the batch pinned dataset v3" mean something.
 */
export function DatasetDetailView({ initial }: { initial: DatasetDetailDto }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [caseDialog, setCaseDialog] = useState<DatasetCaseDto | "new" | null>(null);
  const [editingMeta, setEditingMeta] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const detailQuery = useQuery({
    queryKey: ["dataset", initial.id],
    queryFn: () => api.get<DatasetDetailResponse>(`/api/datasets/${initial.id}`),
    initialData: initial,
  });
  const detail = detailQuery.data;

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["dataset", initial.id] });
    void queryClient.invalidateQueries({ queryKey: ["datasets"] });
    router.refresh();
  };

  const publish = useMutation({
    mutationFn: () =>
      api.post<{ created: boolean; version: DatasetVersionDto }>(
        `/api/datasets/${initial.id}/versions`,
        {},
      ),
    onSuccess: (result) => {
      setNotice(
        result.created
          ? `Published version ${result.version.version} (${result.version.caseCount} cases).`
          : `The working set already matches version ${result.version.version} — nothing to publish.`,
      );
      refresh();
    },
  });

  const removeCase = useMutation({
    mutationFn: (caseKey: string) =>
      api.delete<{ deleted: true }>(
        `/api/datasets/${initial.id}/cases/${encodeURIComponent(caseKey)}`,
      ),
    onSuccess: () => {
      setNotice(null);
      refresh();
    },
  });

  const removeDataset = useMutation({
    mutationFn: () => api.delete<{ deleted: true }>(`/api/datasets/${initial.id}`),
    onSuccess: () => {
      router.push("/dashboard/datasets");
    },
  });
  const deleteError = removeDataset.isError ? errorMessage(removeDataset.error) : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{detail.name}</h1>
            <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[10.5px] text-muted-foreground">
              v{detail.currentVersion}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            {detail.description ?? "No description yet."}
          </p>
          <p className="font-mono text-[11px] text-muted-foreground">{detail.slug}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => setEditingMeta(true)}>
            <Pencil className="h-3.5 w-3.5" />
            Edit details
          </Button>
          <Button asChild variant="outline" size="sm" className="h-8 gap-1.5 text-xs">
            <a href={`/api/datasets/${detail.id}/export`} download>
              <Download className="h-3.5 w-3.5" />
              Export working set
            </a>
          </Button>
          <Button
            size="sm"
            className="h-8 gap-1.5 text-xs"
            data-testid="dataset-publish"
            onClick={() => publish.mutate()}
            disabled={publish.isPending}
          >
            <Upload className="h-3.5 w-3.5" />
            {publish.isPending ? "Publishing…" : "Publish version"}
          </Button>
        </div>
      </div>

      {notice !== null ? (
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{notice}</p>
      ) : null}
      {publish.isError ? (
        <p className="text-xs text-destructive">{errorMessage(publish.error)}</p>
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">Working set</h2>
            <p className="text-xs text-muted-foreground">
              {detail.cases.length} case{detail.cases.length === 1 ? "" : "s"} — editable. Published
              versions below never change.
            </p>
          </div>
          <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => setCaseDialog("new")}>
            <Plus className="h-3.5 w-3.5" />
            Add case
          </Button>
        </div>

        {detail.cases.length === 0 ? (
          <div className="rounded-lg border border-dashed px-6 py-10 text-center text-sm text-muted-foreground">
            No cases yet. Add at least one, then publish a version.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border" data-testid="dataset-cases">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Key</th>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Input</th>
                  <th className="px-3 py-2 font-medium">Expected</th>
                  <th className="px-3 py-2 font-medium">Tags</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {detail.cases.map((entry) => (
                  <tr key={entry.id} className="border-b align-top last:border-b-0 hover:bg-muted/30">
                    <td className="px-3 py-2 font-mono text-xs">{entry.caseKey}</td>
                    <td className="px-3 py-2 text-xs">{entry.name ?? "—"}</td>
                    <td className="max-w-64 px-3 py-2">
                      <span className="line-clamp-2 font-mono text-[11px] text-muted-foreground">
                        {previewValue(entry.input)}
                      </span>
                    </td>
                    <td className="max-w-48 px-3 py-2">
                      <span className="line-clamp-2 font-mono text-[11px] text-muted-foreground">
                        {entry.expectedOutput === null ? "—" : previewValue(entry.expectedOutput)}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span className="flex flex-wrap gap-1">
                        {entry.tags.map((tag) => (
                          <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {tag}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => setCaseDialog(entry)}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                          disabled={removeCase.isPending}
                          onClick={() => {
                            if (window.confirm(`Remove case "${entry.caseKey}" from the working set?`)) {
                              removeCase.mutate(entry.caseKey);
                            }
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-semibold">Published versions</h2>
          <p className="text-xs text-muted-foreground">
            Immutable, content-hashed snapshots. An evaluation pins one of these.
          </p>
        </div>
        {detail.versions.length === 0 ? (
          <div className="rounded-lg border border-dashed px-6 py-8 text-center text-sm text-muted-foreground">
            No versions published yet.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Version</th>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Cases</th>
                  <th className="px-3 py-2 font-medium">Hash</th>
                  <th className="px-3 py-2 font-medium">Published</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {detail.versions.map((version) => (
                  <tr key={version.id} className="border-b last:border-b-0">
                    <td className="px-3 py-2 font-mono text-xs">v{version.version}</td>
                    <td className="px-3 py-2 text-xs">{version.name}</td>
                    <td className="px-3 py-2 font-mono text-xs">{version.caseCount}</td>
                    <td className="px-3 py-2 font-mono text-[10.5px] text-muted-foreground">
                      {version.contentHash.slice(0, 12)}…
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {formatRelativeTime(version.createdAt)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button asChild variant="ghost" size="sm" className="h-7 gap-1 text-xs">
                        <a href={`/api/datasets/${detail.id}/export?version=${version.version}`} download>
                          <Download className="h-3 w-3" />
                          Export
                        </a>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
        <div>
          <p className="text-xs font-medium text-destructive">Delete this dataset</p>
          <p className="text-[11px] text-muted-foreground">
            Refused while an evaluation batch pins it — those results would lose their meaning.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs text-destructive hover:text-destructive"
          disabled={removeDataset.isPending}
          onClick={() => {
            if (window.confirm(`Delete "${detail.name}"?`)) {
              removeDataset.mutate();
            }
          }}
        >
          {removeDataset.isPending ? "Deleting…" : "Delete dataset"}
        </Button>
      </section>
      {deleteError !== null ? <p className="text-xs text-destructive">{deleteError}</p> : null}

      {caseDialog !== null ? (
        <DatasetCaseDialog
          datasetId={detail.id}
          initial={caseDialog === "new" ? null : caseDialog}
          onClose={() => setCaseDialog(null)}
          onSaved={() => {
            setCaseDialog(null);
            refresh();
          }}
        />
      ) : null}

      {editingMeta ? (
        <EditDatasetDialog
          dataset={detail}
          onClose={() => setEditingMeta(false)}
          onSaved={() => {
            setEditingMeta(false);
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function previewValue(value: unknown): string {
  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").slice(0, 160);
  }
  try {
    return JSON.stringify(value).slice(0, 160);
  } catch {
    return String(value);
  }
}

function DatasetCaseDialog({
  datasetId,
  initial,
  onClose,
  onSaved,
}: {
  datasetId: string;
  initial: DatasetCaseDto | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [caseKey, setCaseKey] = useState(initial?.caseKey ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [input, setInput] = useState(
    initial === null ? "" : JSON.stringify(initial.input, null, 2),
  );
  const [expected, setExpected] = useState(
    initial === null || initial.expectedOutput === null
      ? ""
      : JSON.stringify(initial.expectedOutput, null, 2),
  );
  const [tags, setTags] = useState(initial?.tags.join(", ") ?? "");
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const parsedInput = parseJsonField(input, "Input");
      if (!parsedInput.ok) {
        throw new Error(parsedInput.error);
      }
      let expectedValue: unknown = undefined;
      if (expected.trim() !== "") {
        const parsedExpected = parseJsonField(expected, "Expected output");
        if (!parsedExpected.ok) {
          throw new Error(parsedExpected.error);
        }
        expectedValue = parsedExpected.value;
      }
      const tagList = tags
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag !== "");

      // Create and edit have different contracts: creation omits empty optional
      // fields (the schema is strict), while an edit must be able to *clear* a
      // field — that is what null means there.
      const body: Record<string, unknown> = {
        ...(initial === null ? { caseKey } : {}),
        input: parsedInput.value,
        tags: tagList,
      };
      if (name.trim() !== "") {
        body.name = name.trim();
      }
      if (expectedValue !== undefined) {
        body.expectedOutput = expectedValue;
      }

      if (initial === null) {
        return api.post(`/api/datasets/${datasetId}/cases`, body);
      }
      body.name = name.trim() === "" ? null : name.trim();
      body.expectedOutput = expectedValue ?? null;
      return api.patch(`/api/datasets/${datasetId}/cases/${encodeURIComponent(initial.caseKey)}`, body);
    },
    onSuccess: onSaved,
    onError: (mutationError) => setError(errorMessage(mutationError)),
  });

  return (
    <Dialog open onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{initial === null ? "Add test case" : `Edit "${initial.caseKey}"`}</DialogTitle>
          <DialogDescription>
            Input, expected output and metadata are JSON. The case key is the stable identity a
            comparison aligns on.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="case-key">Case key</Label>
              <Input
                id="case-key"
                value={caseKey}
                disabled={initial !== null}
                onChange={(event) => setCaseKey(event.target.value)}
                placeholder="sum-1"
                data-testid="dataset-case-key"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="case-name">Name</Label>
              <Input
                id="case-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Optional label"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="case-input">Input (JSON)</Label>
              <Textarea
                id="case-input"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                rows={6}
                className="font-mono text-[11px]"
                placeholder={`"What is 2 + 2?"`}
                data-testid="dataset-case-input"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="case-expected">Expected output (JSON, optional)</Label>
              <Textarea
                id="case-expected"
                value={expected}
                onChange={(event) => setExpected(event.target.value)}
                rows={6}
                className="font-mono text-[11px]"
                placeholder={`"4"`}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="case-tags">Tags (comma-separated)</Label>
            <Input
              id="case-tags"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="math, smoke"
            />
          </div>

          {error !== null ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="dataset-case-save">
            {save.isPending ? "Saving…" : initial === null ? "Add case" : "Save case"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditDatasetDialog({
  dataset,
  onClose,
  onSaved,
}: {
  dataset: DatasetDetailDto;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(dataset.name);
  const [description, setDescription] = useState(dataset.description ?? "");
  const save = useMutation({
    mutationFn: () =>
      api.patch(`/api/datasets/${dataset.id}`, {
        name: name.trim(),
        description: description.trim() === "" ? null : description.trim(),
      }),
    onSuccess: onSaved,
  });

  return (
    <Dialog open onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit dataset</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-dataset-name">Name</Label>
            <Input id="edit-dataset-name" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-dataset-description">Description</Label>
            <Textarea
              id="edit-dataset-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
            />
          </div>
          {save.isError ? <p className="text-xs text-destructive">{errorMessage(save.error)}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || name.trim() === ""}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
