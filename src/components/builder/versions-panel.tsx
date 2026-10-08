"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, GitCommitHorizontal, History, Loader2, Lock } from "lucide-react";
import { api, errorMessage, errorMessageWithIssues, type ApiIssue } from "@/lib/api/client";
import { useEditorStore } from "@/modules/harness/editor/editor-store";
import { coerceHarnessDocument } from "@/modules/harness/editor/react-flow-adapter";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface VersionDto {
  id: string;
  version: number;
  name: string;
  definition: { nodes?: unknown[]; edges?: unknown[] };
  contentHash: string;
  releaseNotes: string | null;
  createdAt: string;
  createdBy: string | null;
}

interface VersionsResponse {
  versions: VersionDto[];
}

interface PublishResponse {
  harnessVersion: VersionDto;
  created: boolean;
}

/**
 * Version history.
 *
 * Versions are immutable: this panel can load one into the draft or publish the
 * draft as a new version — it can never edit history. Restoring a version is
 * therefore "open into draft, then publish", which keeps the audit trail honest.
 */
export function VersionsPanel({ harnessId }: { harnessId: string }) {
  const queryClient = useQueryClient();
  const issueCount = useEditorStore((state) => state.issues.length);
  const setPanel = useEditorStore((state) => state.setPanel);
  const setServerIssues = useEditorStore((state) => state.setServerIssues);
  const hasDraftChanges = useEditorStore((state) => state.revision > state.savedRevision);
  const [releaseNotes, setReleaseNotes] = useState("");
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const versionsQuery = useQuery({
    queryKey: ["harness", harnessId, "versions"],
    queryFn: () => api.get<VersionsResponse>(`/api/harnesses/${harnessId}/versions`),
    refetchOnWindowFocus: false,
  });

  const publishMutation = useMutation({
    mutationFn: () =>
      api.post<PublishResponse>(`/api/harnesses/${harnessId}/versions`, {
        releaseNotes: releaseNotes.trim() ? releaseNotes.trim() : undefined,
      }),
    onSuccess: (result) => {
      setNotice({
        kind: "ok",
        text: result.created
          ? `Version v${result.harnessVersion.version} created`
          : `Draft already matches v${result.harnessVersion.version} — nothing new to publish`,
      });
      setReleaseNotes("");
      void queryClient.invalidateQueries({ queryKey: ["harness", harnessId] });
    },
    onError: (error) => {
      const issues = error instanceof Object && "issues" in error ? (error as { issues: ApiIssue[] }).issues : [];
      if (issues.length > 0) {
        setServerIssues(issues);
        setPanel("validation");
      }
      setNotice({ kind: "error", text: errorMessageWithIssues(error) });
    },
  });

  const versions = versionsQuery.data?.versions ?? [];
  const latest = versions[0];
  const nextVersion = latest ? latest.version + 1 : 1;

  function openVersion(version: VersionDto) {
    const coerced = coerceHarnessDocument(version.definition);
    const store = useEditorStore.getState();
    store.init({
      harnessId,
      name: store.harnessName,
      description: store.harnessDescription || null,
      nodes: coerced.nodes,
      edges: coerced.edges,
      issues: [],
      validationStatus: "unknown",
    });
    store.revalidate();
    setNotice({
      kind: "ok",
      text: `Loaded v${version.version} into the draft (${coerced.nodes.length} nodes). Publish to keep it as a new version.`,
    });
    setPanel("inspector");
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-3 py-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Versions
        </p>
        <p className="text-[11px] text-muted-foreground">
          {versions.length} version{versions.length === 1 ? "" : "s"}
          {hasDraftChanges ? " · draft has unsaved changes" : " · draft saved"}
        </p>
      </div>

      <div className="space-y-2 border-b px-3 py-3">
        <p className="text-xs font-medium">Publish v{nextVersion}</p>
        <Textarea
          value={releaseNotes}
          onChange={(event) => setReleaseNotes(event.target.value)}
          rows={2}
          maxLength={1000}
          placeholder="Release notes — what changed in this version?"
          data-testid="publish-release-notes"
          className="text-xs"
        />
        <Button
          size="sm"
          className="h-7 w-full gap-1.5 text-xs"
          disabled={publishMutation.isPending}
          data-testid="publish-version"
          onClick={() => publishMutation.mutate()}
        >
          {publishMutation.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <GitCommitHorizontal className="h-3 w-3" />
          )}
          Create version
        </Button>
        {issueCount > 0 ? (
          <p className="flex items-center gap-1.5 text-[10.5px] text-destructive">
            <AlertTriangle className="h-3 w-3" />
            {issueCount} validation problem{issueCount === 1 ? "" : "s"} — publishing will fail until
            the graph is valid.
          </p>
        ) : (
          <p className="text-[10.5px] leading-4 text-muted-foreground">
            Publishing validates the draft and writes an immutable snapshot. Runs pin this version,
            so history never changes underneath them.
          </p>
        )}
      </div>

      {notice ? (
        <div
          className={cn(
            "flex items-start gap-1.5 border-b px-3 py-2 text-[11px] leading-4",
            notice.kind === "ok"
              ? "bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
              : "bg-destructive/5 text-destructive",
          )}
          data-testid="versions-notice"
        >
          {notice.kind === "ok" ? (
            <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" />
          ) : (
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          )}
          <span>{notice.text}</span>
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {versionsQuery.isLoading ? (
          <p className="text-[11px] text-muted-foreground">Loading versions…</p>
        ) : versionsQuery.isError ? (
          <p className="text-[11px] text-destructive">{errorMessage(versionsQuery.error)}</p>
        ) : versions.length === 0 ? (
          <p className="text-[11px] leading-4 text-muted-foreground">
            No versions yet. The draft is autosaved continuously; publish when the graph is ready.
          </p>
        ) : (
          <ul className="space-y-2" data-testid="version-list">
            {versions.map((version, index) => (
              <li
                key={version.id}
                className="rounded-md border px-2.5 py-2"
                data-testid={`version-item-${version.version}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-xs font-medium">
                    v{version.version}
                    {index === 0 ? (
                      <span className="rounded bg-primary/10 px-1 py-0.5 text-[9.5px] font-semibold uppercase text-primary">
                        latest
                      </span>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <Lock className="h-2.5 w-2.5" />
                    immutable
                  </span>
                </div>
                <p className="mt-1 text-[10.5px] leading-4 text-muted-foreground">
                  {version.definition.nodes?.length ?? 0} nodes ·{" "}
                  {version.definition.edges?.length ?? 0} connections
                </p>
                {version.releaseNotes ? (
                  <p className="mt-1 line-clamp-2 text-[10.5px] leading-4">{version.releaseNotes}</p>
                ) : null}
                <p className="mt-1 font-mono text-[9.5px] text-muted-foreground">
                  {new Date(version.createdAt).toLocaleString()} · {version.contentHash.slice(0, 10)}
                </p>
                <div className="mt-2 flex gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-[10.5px]"
                    data-testid={`open-version-${version.version}`}
                    onClick={() => openVersion(version)}
                  >
                    <History className="mr-1 h-3 w-3" />
                    Open into draft
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
