"use client";

import { useEffect } from "react";
import { useReactFlow } from "@xyflow/react";
import { useEditorStore } from "./editor-store";

/**
 * Builder keyboard shortcuts.
 *
 * Editing keys are inert while the user is typing in a field (except Ctrl/Cmd+S,
 * which must always save). Space-to-pan and F-to-fit come from React Flow's own
 * `panActivationKeyCode` and the fit call below, so nothing is reinvented.
 */

export interface ShortcutHandlers {
  onSave: () => void;
  onShowShortcuts: () => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName.toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    target.isContentEditable ||
    target.closest("[role='dialog']") !== null
  );
}

export function useBuilderShortcuts({ onSave, onShowShortcuts }: ShortcutHandlers): void {
  const { fitView } = useReactFlow();

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const store = useEditorStore.getState();
      const typing = isTypingTarget(event.target);
      const mod = event.metaKey || event.ctrlKey;

      // Save works everywhere, including from inside a field.
      if (mod && event.key.toLowerCase() === "s") {
        event.preventDefault();
        onSave();
        return;
      }

      if (typing) {
        return;
      }

      if (mod && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          store.redo();
        } else {
          store.undo();
        }
        return;
      }

      if (mod && event.key.toLowerCase() === "d") {
        event.preventDefault();
        const created = store.duplicateSelection();
        if (created.length > 0) {
          void fitView({ nodes: created.map((id) => ({ id })), duration: 250, padding: 0.3 });
        }
        return;
      }

      if (event.key === "Delete" || event.key === "Backspace") {
        const nodeIds = store.selectedNodeIds.length > 0
          ? store.selectedNodeIds
          : store.selectedNodeId
            ? [store.selectedNodeId]
            : [];
        if (nodeIds.length === 0 && store.selectedEdgeIds.length === 0) {
          return;
        }
        event.preventDefault();
        store.removeNodes(nodeIds);
        store.removeEdges(store.selectedEdgeIds);
        return;
      }

      if (event.key === "f" || event.key === "F") {
        event.preventDefault();
        void fitView({ duration: 250, padding: 0.2 });
        return;
      }

      if (event.key === "?") {
        event.preventDefault();
        onShowShortcuts();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [fitView, onSave, onShowShortcuts]);
}
