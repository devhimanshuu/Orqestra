"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, type ApiIssue } from "@/lib/api/client";
import { useEditorStore } from "./editor-store";

/**
 * Draft autosave + live validation for the builder.
 *
 * Autosave writes the *draft* only — never a version. Versions are created
 * explicitly by the user through "Publish version".
 */

const AUTOSAVE_DELAY_MS = 1200;
const VALIDATE_DELAY_MS = 350;

interface DraftResponse {
  draft: { harnessId: string; updatedAt: string };
  status: string;
  validation: { ok: boolean; issues: ApiIssue[] };
}

export interface AutosaveHandle {
  /** Force an immediate save (Ctrl+S). Resolves once the request settles. */
  saveNow: () => Promise<boolean>;
  saving: boolean;
  dirty: boolean;
  lastSavedAt: number | null;
  error: string | null;
}

export function useHarnessAutosave(harnessId: string): AutosaveHandle {
  const revision = useEditorStore((state) => state.revision);
  const savedRevision = useEditorStore((state) => state.savedRevision);
  const saveState = useEditorStore((state) => state.saveState);
  const saveError = useEditorStore((state) => state.saveError);
  const savedAt = useEditorStore((state) => state.savedAt);
  const [inflight, setInflight] = useState(false);
  const savingRef = useRef(false);

  const dirty = revision > savedRevision;
  const saving = saveState === "saving" || inflight;

  const saveNow = useCallback(async (): Promise<boolean> => {
    const store = useEditorStore.getState();
    if (!harnessId) {
      return false;
    }
    if (savingRef.current) {
      // A save is already in flight; the trailing autosave will pick up changes.
      return false;
    }
    if (store.revision <= store.savedRevision && store.saveState !== "dirty") {
      return true;
    }
    const revisionAtSave = store.revision;
    const definition = store.document();
    savingRef.current = true;
    setInflight(true);
    store.markSaving();
    try {
      const response = await api.put<DraftResponse>(`/api/harnesses/${harnessId}/draft`, {
        definition,
      });
      useEditorStore.getState().setServerIssues(response.validation.issues);
      useEditorStore.getState().markSaved(revisionAtSave);
      return true;
    } catch (error) {
      useEditorStore.getState().markSaveError(errorMessage(error));
      return false;
    } finally {
      savingRef.current = false;
      setInflight(false);
    }
  }, [harnessId]);

  // Debounced autosave: draft changes, never versions.
  useEffect(() => {
    if (!harnessId || revision === 0 || revision <= savedRevision) {
      return;
    }
    const timer = setTimeout(() => {
      void saveNow();
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [harnessId, revision, savedRevision, saveNow]);

  // Debounced client-side validation: identical rules to the server, instant UI.
  useEffect(() => {
    if (revision === 0) {
      return;
    }
    const timer = setTimeout(() => {
      useEditorStore.getState().revalidate();
    }, VALIDATE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [revision]);

  return { saveNow, saving, dirty, lastSavedAt: savedAt, error: saveError };
}

/** Publishes the current draft as an immutable version. */
export async function publishVersion(
  harnessId: string,
  releaseNotes: string,
): Promise<{ ok: true; version: number; created: boolean } | { ok: false; error: string; issues: ApiIssue[] }> {
  try {
    const response = await api.post<{ harnessVersion: { version: number }; created: boolean }>(
      `/api/harnesses/${harnessId}/versions`,
      { releaseNotes: releaseNotes.trim() ? releaseNotes.trim() : undefined },
    );
    return { ok: true, version: response.harnessVersion.version, created: response.created };
  } catch (error) {
    return {
      ok: false,
      error: errorMessage(error),
      issues: error && typeof error === "object" && "issues" in error
        ? ((error as { issues: ApiIssue[] }).issues ?? [])
        : [],
    };
  }
}
