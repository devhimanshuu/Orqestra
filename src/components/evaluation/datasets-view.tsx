"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Database, FileUp, Plus, RefreshCw, Search } from "lucide-react";
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

export interface ProjectOption {
  id: string;
  name: string;
}

export interface DatasetRowDto {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  description: string | null;
  currentVersion: number;
  caseCount: number;
  versionCount: number;
  batchCount: number;
  updatedAt: string;
}

interface DatasetsResponse {
  datasets: DatasetRowDto[];
  total: number;
}

/**
 * Datasets: versioned test corpora.
 *
 * The list is server-rendered and re-fetched after every mutation; a dataset's
 * working set and its published versions are edited on the detail page, because
 * that is where the "editing never changes a published version" distinction is
 * visible.
 */
export function DatasetsView({
  projects,
  initialDatasets,
}: {
  projects: ProjectOption[];
  initialDatasets: DatasetRowDto[];
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const datasetsQuery = useQuery({
    queryKey: ["datasets"],
    queryFn: () => api.get<DatasetsResponse>("/api/datasets"),
    initialData: { datasets: initialDatasets, total: initialDatasets.length },
  });

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const all = datasetsQuery.data?.datasets ?? [];
    if (needle === "") {
      return all;
    }
    return all.filter(
      (row) => row.name.toLowerCase().includes(needle) || row.slug.toLowerCase().includes(needle),
    );
  }, [datasetsQuery.data, search]);

  const projectName = (projectId: string): string =>
    projects.find((project) => project.id === projectId)?.name ?? "—";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="relative flex items-center">
          <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search datasets…"
            data-testid="datasets-search"
            className="h-8 w-64 pl-8"
          />
        </label>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => setImportOpen(true)}>
            <FileUp className="h-3.5 w-3.5" />
            Import file
          </Button>
          <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={() => setCreateOpen(true)}>
            <Plus className="h-3.5 w-3.5" />
            New dataset
          </Button>
        </div>
      </div>

      {notice !== null ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {notice}
        </p>
      ) : null}

      {datasetsQuery.isFetching ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <RefreshCw className="h-3 w-3 animate-spin" /> Refreshing…
        </p>
      ) : null}

      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-14 text-center">
          <Database className="h-5 w-5 text-muted-foreground" />
          <p className="text-sm font-medium">
            {search !== "" ? "No datasets match this search" : "No datasets yet"}
          </p>
          <p className="max-w-md text-sm text-muted-foreground">
            A dataset is a list of test cases (input plus optional expected output). Publish a
            version, then evaluate a harness version against it.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border" data-testid="datasets-table">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Dataset</th>
                <th className="px-4 py-2 font-medium">Project</th>
                <th className="px-4 py-2 font-medium">Version</th>
                <th className="px-4 py-2 font-medium">Cases</th>
                <th className="px-4 py-2 font-medium">Evaluations</th>
                <th className="px-4 py-2 font-medium">Updated</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b last:border-b-0 hover:bg-muted/30">
                  <td className="px-4 py-2.5">
                    <Link href={`/dashboard/datasets/${row.id}`} className="text-sm font-medium hover:underline">
                      {row.name}
                    </Link>
                    <p className="mt-0.5 font-mono text-[10.5px] text-muted-foreground">{row.slug}</p>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">{projectName(row.projectId)}</td>
                  <td className="px-4 py-2.5 font-mono text-xs">v{row.currentVersion}</td>
                  <td className="px-4 py-2.5 font-mono text-xs">{row.caseCount}</td>
                  <td className="px-4 py-2.5 font-mono text-xs">{row.batchCount}</td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">
                    {formatRelativeTime(row.updatedAt)}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Button asChild variant="ghost" size="sm" className="h-7 gap-1 text-xs">
                      <Link href={`/dashboard/datasets/${row.id}`}>
                        Open
                        <ChevronRight className="h-3 w-3" />
                      </Link>
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreateDatasetDialog
        open={createOpen}
        projects={projects}
        onClose={() => setCreateOpen(false)}
        onCreated={(datasetId) => {
          setCreateOpen(false);
          void queryClient.invalidateQueries({ queryKey: ["datasets"] });
          router.push(`/dashboard/datasets/${datasetId}`);
        }}
      />
      <ImportDatasetDialog
        open={importOpen}
        projects={projects}
        datasets={datasetsQuery.data?.datasets ?? []}
        onClose={() => setImportOpen(false)}
        onImported={(message) => {
          setImportOpen(false);
          setNotice(message);
          void queryClient.invalidateQueries({ queryKey: ["datasets"] });
        }}
        onError={(message) => setNotice(message)}
      />
    </div>
  );
}

function CreateDatasetDialog({
  open,
  projects,
  onClose,
  onCreated,
}: {
  open: boolean;
  projects: ProjectOption[];
  onClose: () => void;
  onCreated: (datasetId: string) => void;
}) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [casesText, setCasesText] = useState("");

  const create = useMutation({
    mutationFn: async () => {
      let cases: unknown[] | undefined;
      if (casesText.trim() !== "") {
        const parsed: unknown = JSON.parse(casesText);
        if (!Array.isArray(parsed)) {
          throw new Error("Cases must be a JSON array");
        }
        cases = parsed;
      }
      return api.post<{ dataset: { id: string } }>("/api/datasets", {
        projectId,
        name,
        ...(description.trim() !== "" ? { description } : {}),
        ...(cases !== undefined ? { cases } : {}),
      });
    },
    onSuccess: (result) => {
      setName("");
      setDescription("");
      setCasesText("");
      onCreated(result.dataset.id);
    },
  });

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>New dataset</DialogTitle>
          <DialogDescription>
            Version 1 is published from the cases you provide, so an evaluation can pin it
            immediately.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dataset-project">Project</Label>
              <select
                id="dataset-project"
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
              <Label htmlFor="dataset-name">Name</Label>
              <Input
                id="dataset-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Arithmetic checks"
                data-testid="dataset-name"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dataset-description">Description</Label>
            <Input
              id="dataset-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Optional"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dataset-cases">Initial cases (JSON array, optional)</Label>
            <Textarea
              id="dataset-cases"
              value={casesText}
              onChange={(event) => setCasesText(event.target.value)}
              rows={5}
              className="font-mono text-[11px]"
              placeholder={`[{"caseKey":"sum-1","input":"What is 2 + 2?","expectedOutput":"4"}]`}
            />
            <p className="text-[11px] text-muted-foreground">
              Every case needs a stable <code className="font-mono">caseKey</code>: comparisons
              align on it, never on position.
            </p>
          </div>

          {create.isError ? (
            <p className="text-xs text-destructive">{errorMessage(create.error)}</p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={create.isPending || projectId === "" || name.trim() === ""}
            data-testid="dataset-create-submit"
          >
            {create.isPending ? "Creating…" : "Create dataset"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportDatasetDialog({
  open,
  projects,
  datasets,
  onClose,
  onImported,
  onError,
}: {
  open: boolean;
  projects: ProjectOption[];
  datasets: DatasetRowDto[];
  onClose: () => void;
  onImported: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [mode, setMode] = useState<"create" | "replace">("create");
  const [datasetId, setDatasetId] = useState("");
  const [documentText, setDocumentText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: async () => {
      let document: unknown;
      try {
        document = JSON.parse(documentText);
      } catch {
        throw new Error("The file must be valid JSON");
      }
      return api.post<{ dataset: { id: string; name: string }; importedCases: number; replaced: boolean }>(
        "/api/datasets/import",
        {
          projectId,
          document,
          mode,
          ...(mode === "replace" && datasetId !== "" ? { datasetId } : {}),
        },
      );
    },
    onSuccess: (result) => {
      onImported(
        `${result.replaced ? "Replaced" : "Imported"} ${result.importedCases} case(s) into "${result.dataset.name}".`,
      );
    },
    onError: (error) => onError(errorMessage(error)),
  });

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Import dataset file</DialogTitle>
          <DialogDescription>
            Accepts an exported dataset file or a plain <code className="font-mono">{"{ name, cases }"}</code>{" "}
            document. The whole file is validated before anything is written.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-3 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="import-project">Project</Label>
              <select
                id="import-project"
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
              <Label htmlFor="import-mode">Mode</Label>
              <select
                id="import-mode"
                value={mode}
                onChange={(event) => setMode(event.target.value === "replace" ? "replace" : "create")}
                className="h-9 rounded-md border bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
              >
                <option value="create">Create new dataset</option>
                <option value="replace">Replace working set</option>
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="import-file">File</Label>
              <input
                id="import-file"
                type="file"
                accept="application/json,.json"
                data-testid="dataset-import-file"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (file === undefined) {
                    return;
                  }
                  setFileName(file.name);
                  setDocumentText(await file.text());
                }}
                className="h-9 w-full rounded-md border bg-transparent px-2 py-1.5 text-xs file:mr-2 file:rounded file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs"
              />
            </div>
          </div>

          {mode === "replace" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="import-dataset">Replace working set of</Label>
              <select
                id="import-dataset"
                value={datasetId}
                onChange={(event) => setDatasetId(event.target.value)}
                className="h-9 rounded-md border bg-transparent px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
              >
                <option value="">Select a dataset…</option>
                {datasets.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-muted-foreground">
                Published versions and completed evaluations are untouched.
              </p>
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="import-text">
              Document {fileName !== null ? `(${fileName})` : "— paste JSON or choose a file"}
            </Label>
            <Textarea
              id="import-text"
              value={documentText}
              onChange={(event) => setDocumentText(event.target.value)}
              rows={6}
              className="font-mono text-[11px]"
              placeholder={`{"name":"Arithmetic","cases":[{"caseKey":"sum-1","input":"2+2","expectedOutput":"4"}]}`}
            />
          </div>

          {run.isError ? <p className="text-xs text-destructive">{errorMessage(run.error)}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => run.mutate()}
            disabled={
              run.isPending ||
              projectId === "" ||
              documentText.trim() === "" ||
              (mode === "replace" && datasetId === "")
            }
          >
            {run.isPending ? "Importing…" : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
