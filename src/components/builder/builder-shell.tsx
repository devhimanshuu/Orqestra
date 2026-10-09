"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import {
  Check,
  ChevronRight,
  Copy,
  Download,
  FileQuestion,
  Keyboard,
  Loader2,
  Redo2,
  Undo2,
  Upload,
} from "lucide-react";
import { api, errorMessage, type ApiIssue } from "@/lib/api/client";
import { useEditorStore } from "@/modules/harness/editor/editor-store";
import { coerceHarnessDocument } from "@/modules/harness/editor/react-flow-adapter";
import { useHarnessAutosave } from "@/modules/harness/editor/use-harness-autosave";
import { useBuilderShortcuts } from "@/modules/harness/editor/use-builder-shortcuts";
import { BuilderCanvas } from "./builder-canvas";
import { RunHarnessDialog } from "./run-harness-dialog";
import { InspectorPanel } from "./inspector-panel";
import { NodeLibrary } from "./node-library";
import { ValidationPanel } from "./validation-panel";
import { VersionsPanel } from "./versions-panel";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export interface BuilderPayload {
  harness: {
    id: string;
    agentId: string | null;
    name: string;
    slug: string;
    description: string | null;
    status: string;
    currentVersion: number;
  };
  /** Raw draft/version definition — may be mid-edit and invalid. */
  currentDefinition: unknown;
  validation: { ok: boolean; issues: ApiIssue[] };
  agent: { id: string; name: string } | null;
  projectName: string;
  projectId: string;
}

/**
 * The visual harness builder. React Flow is the editor; the harness DSL is the
 * product representation — the store serializes itself back to a draft document
 * and autosave writes drafts only. Versions are published explicitly.
 */
export function BuilderShell({ payload }: { payload: BuilderPayload }) {
  return (
    <ReactFlowProvider>
      <BuilderWorkspace payload={payload} />
    </ReactFlowProvider>
  );
}

function BuilderWorkspace({ payload }: { payload: BuilderPayload }) {
  const router = useRouter();
  const harnessId = payload.harness.id;
  const initialized = useEditorStore((state) => state.initialized);
  const activePanel = useEditorStore((state) => state.activePanel);
  const setPanel = useEditorStore((state) => state.setPanel);
  const issueCount = useEditorStore((state) => state.issues.length);
  const validationStatus = useEditorStore((state) => state.validationStatus);
  const pastCount = useEditorStore((state) => state.past.length);
  const futureCount = useEditorStore((state) => state.future.length);

  const autosave = useHarnessAutosave(harnessId);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Lenient coercion of the persisted graph is derived, never effect state.
  const coerced = useMemo(
    () => coerceHarnessDocument(payload.currentDefinition),
    [payload.currentDefinition],
  );
  const coerceNotice =
    coerced.droppedNodes > 0 || coerced.droppedEdges > 0
      ? `Recovered the graph, but dropped ${coerced.droppedNodes} node(s) and ${coerced.droppedEdges} edge(s) that failed the schema.`
      : null;

  // Load the persisted graph into the editor store exactly once per harness.
  useEffect(() => {
    const store = useEditorStore.getState();
    if (store.initialized && store.harnessId === harnessId) {
      return;
    }
    store.init({
      harnessId,
      name: payload.harness.name,
      description: payload.harness.description,
      nodes: coerced.nodes,
      edges: coerced.edges,
      issues: payload.validation.issues,
      validationStatus: payload.validation.ok
        ? "valid"
        : payload.validation.issues.length > 0
          ? "invalid"
          : "unknown",
    });
    return () => {
      useEditorStore.getState().reset();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [harnessId, coerced]);

  const handleSave = useCallback(() => {
    void autosave.saveNow();
  }, [autosave]);

  const handleValidate = useCallback(() => {
    // Client-side rules run instantly; the server re-confirms with the same rules.
    useEditorStore.getState().revalidate();
    const definition = useEditorStore.getState().document();
    void api
      .post<{ ok: boolean; issues: ApiIssue[] }>(`/api/harnesses/${harnessId}/validate`, definition)
      .then((result) => {
        useEditorStore.getState().setServerIssues(result.ok ? [] : result.issues);
      })
      .catch((error) => {
        useEditorStore.getState().markSaveError(errorMessage(error));
      });
  }, [harnessId]);

  useBuilderShortcuts({
    onSave: handleSave,
    onShowShortcuts: () => setShortcutsOpen(true),
  });

  async function handleExport(): Promise<void> {
    try {
      const result = await api.get<{ fileName: string; document: unknown }>(
        `/api/harnesses/${harnessId}/export`,
      );
      const blob = new Blob([JSON.stringify(result.document, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      useEditorStore.getState().markSaveError(errorMessage(error));
    }
  }

  function handleImportFile(event: React.ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !payload.harness.agentId) {
      return;
    }
    void file
      .text()
      .then((text) => {
        const document = JSON.parse(text) as { definition?: unknown };
        return api.post<{ harness: { id: string } }>("/api/harnesses/import", {
          agentId: payload.harness.agentId,
          document: document.definition !== undefined ? document.definition : document,
        });
      })
      .then((created) => {
        router.push(`/dashboard/harnesses/${created.harness.id}/builder`);
      })
      .catch((error) => {
        useEditorStore.getState().markSaveError(errorMessage(error));
      });
  }

  const editorStatus =
    validationStatus === "valid"
      ? "VALID"
      : validationStatus === "invalid"
        ? "INVALID"
        : payload.harness.status;

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
        <nav
          className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
          aria-label="Breadcrumb"
        >
          <Link href="/dashboard" className="hover:text-foreground">
            {payload.projectName}
          </Link>
          <ChevronRight className="h-3 w-3 shrink-0" />
          {payload.agent ? (
            <>
              <Link
                href={`/dashboard/agents/${payload.agent.id}`}
                className="truncate hover:text-foreground"
              >
                {payload.agent.name}
              </Link>
              <ChevronRight className="h-3 w-3 shrink-0" />
            </>
          ) : null}
          <span className="truncate font-medium text-foreground" data-testid="builder-harness-name">
            {payload.harness.name}
          </span>
          <span className="ml-1 rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
            v{payload.harness.currentVersion}
          </span>
        </nav>

        <StatusBadge status={editorStatus} />
        <SaveIndicator
          saving={autosave.saving}
          dirty={autosave.dirty}
          error={autosave.error}
          lastSavedAt={autosave.lastSavedAt}
        />

        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            title="Undo (Ctrl+Z)"
            aria-label="Undo"
            disabled={pastCount === 0}
            onClick={() => useEditorStore.getState().undo()}
          >
            <Undo2 className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title="Redo (Ctrl+Shift+Z)"
            aria-label="Redo"
            disabled={futureCount === 0}
            onClick={() => useEditorStore.getState().redo()}
          >
            <Redo2 className="h-3.5 w-3.5" />
          </Button>

          <span className="mx-1 h-5 w-px bg-border" />

          <Link
            href={`/dashboard/runs?harnessId=${payload.harness.id}`}
            className="hidden h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground sm:inline-flex"
            data-testid="harness-runs"
          >
            Runs
          </Link>

          <RunHarnessDialog
            harnessId={payload.harness.id}
            disabled={payload.harness.agentId === null}
          />

          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            data-testid="export-harness"
            onClick={() => void handleExport()}
          >
            <Download className="h-3 w-3" />
            Export
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            data-testid="import-harness"
            disabled={payload.harness.agentId === null}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="h-3 w-3" />
            Import
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            aria-hidden
            onChange={handleImportFile}
          />
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            data-testid="duplicate-harness"
            disabled={payload.harness.agentId === null}
            onClick={() => setDuplicateOpen(true)}
          >
            <Copy className="h-3 w-3" />
            Duplicate
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title="Keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
            onClick={() => setShortcutsOpen(true)}
          >
            <Keyboard className="h-3.5 w-3.5" />
          </Button>
        </div>
      </header>

      {coerceNotice ? (
        <p className="border-b bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
          {coerceNotice}
        </p>
      ) : null}

      {/* Desktop-first editor; small screens get an honest message. */}
      <div className="hidden min-h-0 flex-1 md:flex">
        <aside className="w-56 shrink-0 border-r bg-background" data-testid="node-library">
          <NodeLibrary />
        </aside>

        <main className="min-w-0 flex-1" data-testid="builder-canvas">
          {initialized ? <BuilderCanvas /> : <CanvasLoading />}
        </main>

        <aside className="flex w-80 shrink-0 flex-col border-l bg-background">
          <div className="flex shrink-0 border-b" role="tablist" aria-label="Builder panels">
            <PanelTab
              active={activePanel === "inspector"}
              onClick={() => setPanel("inspector")}
              label="Inspector"
              testId="builder-tab-inspector"
            />
            {/* The label carries the live issue count, so the stable id is the
                test id rather than the accessible name. */}
            <PanelTab
              active={activePanel === "validation"}
              onClick={() => setPanel("validation")}
              label={issueCount > 0 ? `Issues (${issueCount})` : "Validation"}
              alert={issueCount > 0}
              testId="builder-tab-validation"
            />
            <PanelTab
              active={activePanel === "versions"}
              onClick={() => setPanel("versions")}
              label="Versions"
              testId="builder-tab-versions"
            />
          </div>
          <div className="min-h-0 flex-1">
            {activePanel === "inspector" ? <InspectorPanel /> : null}
            {activePanel === "validation" ? <ValidationPanel onValidate={handleValidate} /> : null}
            {activePanel === "versions" ? <VersionsPanel harnessId={harnessId} /> : null}
          </div>
        </aside>
      </div>

      <div className="flex flex-1 items-center justify-center px-6 text-center md:hidden">
        <div>
          <FileQuestion className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium">The harness builder needs a larger screen</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Open Orqestra on a desktop to edit this harness visually. Your draft is safe — it is
            stored on the server.
          </p>
        </div>
      </div>

      <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
            <DialogDescription>Editing keys are inert while typing in a field.</DialogDescription>
          </DialogHeader>
          <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-2 text-sm">
            <ShortcutRow label="Delete selected" keys={["Delete", "Backspace"]} />
            <ShortcutRow label="Undo" keys={["Ctrl/⌘", "Z"]} />
            <ShortcutRow label="Redo" keys={["Ctrl/⌘", "Shift", "Z"]} />
            <ShortcutRow label="Save draft" keys={["Ctrl/⌘", "S"]} />
            <ShortcutRow label="Duplicate selection" keys={["Ctrl/⌘", "D"]} />
            <ShortcutRow label="Pan canvas" keys={["Space", "drag"]} />
            <ShortcutRow label="Fit view" keys={["F"]} />
            <ShortcutRow label="This dialog" keys={["?"]} />
          </dl>
        </DialogContent>
      </Dialog>

      {duplicateOpen ? (
        <DuplicateDialog
          onOpenChange={setDuplicateOpen}
          harnessId={harnessId}
          defaultName={`${payload.harness.name} — Experimental`}
        />
      ) : null}
    </div>
  );
}

function PanelTab({
  active,
  onClick,
  label,
  alert,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  alert?: boolean;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-testid={testId}
      onClick={onClick}
      className={cn(
        "flex-1 border-b-2 px-2 py-2 text-[11px] font-medium transition-colors",
        active
          ? "border-foreground text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
        alert && !active && "text-destructive",
      )}
    >
      {label}
    </button>
  );
}

function SaveIndicator({
  saving,
  dirty,
  error,
  lastSavedAt,
}: {
  saving: boolean;
  dirty: boolean;
  error: string | null;
  lastSavedAt: number | null;
}) {
  if (error !== null) {
    return (
      <span className="text-[11px] text-destructive" data-testid="save-status" title={error}>
        Save failed
      </span>
    );
  }
  if (saving) {
    return (
      <span
        className="flex items-center gap-1 text-[11px] text-muted-foreground"
        data-testid="save-status"
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        Saving…
      </span>
    );
  }
  if (dirty) {
    return (
      <span className="text-[11px] text-muted-foreground" data-testid="save-status">
        Unsaved changes
      </span>
    );
  }
  return (
    <span
      className="flex items-center gap-1 text-[11px] text-muted-foreground"
      data-testid="save-status"
    >
      <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
      {lastSavedAt ? `Saved ${new Date(lastSavedAt).toLocaleTimeString()}` : "Saved"}
    </span>
  );
}

function CanvasLoading() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      Loading canvas…
    </div>
  );
}

function ShortcutRow({ label, keys }: { label: string; keys: string[] }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex justify-end gap-1">
        {keys.map((key) => (
          <kbd
            key={key}
            className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
          >
            {key}
          </kbd>
        ))}
      </dd>
    </>
  );
}

/** Mounted only while open, so local state starts fresh on every open. */
function DuplicateDialog({
  onOpenChange,
  harnessId,
  defaultName,
}: {
  onOpenChange: (open: boolean) => void;
  harnessId: string;
  defaultName: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(defaultName);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const created = await api.post<{ harness: { id: string } }>(
        `/api/harnesses/${harnessId}/duplicate`,
        { name: name.trim() || undefined },
      );
      onOpenChange(false);
      router.push(`/dashboard/harnesses/${created.harness.id}/builder`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog defaultOpen onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Duplicate harness</DialogTitle>
          <DialogDescription>
            Copies the current graph into a new harness at v1 — useful for experiments and future
            A/B testing.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="duplicate-name">New name</Label>
            <Input
              id="duplicate-name"
              data-testid="duplicate-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              autoFocus
            />
          </div>
          {error !== null && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end">
            <Button type="submit" disabled={pending} data-testid="duplicate-submit">
              {pending ? "Duplicating…" : "Duplicate"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
