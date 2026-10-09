"use client";

import { useMemo, useState } from "react";
import {
  Database,
  Gauge,
  GitBranch,
  Layers,
  ListTree,
  MessageSquare,
  Play,
  Repeat,
  Search,
  ShieldCheck,
  Shuffle,
  Sparkles,
  Split,
  Square,
  UserCheck,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { NODE_TYPES_BY_CATEGORY } from "@/modules/harness/editor/node-catalog";
import { useEditorStore } from "@/modules/harness/editor/editor-store";
import type { HarnessNodeType } from "@/modules/harness/harness.schema";
import { Input } from "@/components/ui/input";
import { NODE_DRAG_MIME } from "./builder-canvas";

const ICONS: Record<string, LucideIcon> = {
  Play,
  Square,
  Sparkles,
  MessageSquare,
  Wrench,
  Database,
  Layers,
  ListTree,
  Split,
  ShieldCheck,
  Gauge,
  GitBranch,
  Repeat,
  UserCheck,
  Shuffle,
};

/**
 * Node library. Items are both draggable (position comes from the drop point)
 * and clickable (cascaded placement) so the editor is usable with a mouse and
 * with a trackpad-only setup.
 */
export function NodeLibrary() {
  const [query, setQuery] = useState("");
  const nodeCount = useEditorStore((state) => state.nodes.length);

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return NODE_TYPES_BY_CATEGORY.map((group) => ({
      ...group,
      nodeTypes: needle
        ? group.nodeTypes.filter(
            (meta) =>
              meta.label.toLowerCase().includes(needle) ||
              meta.type.includes(needle) ||
              meta.description.toLowerCase().includes(needle),
          )
        : group.nodeTypes,
    })).filter((group) => group.nodeTypes.length > 0);
  }, [query]);

  function addNode(type: HarnessNodeType) {
    // Library clicks have no drop point; the store picks a free slot so nodes
    // never land on top of each other (which would hide their handles).
    useEditorStore.getState().addNode(type, { x: 0, y: 0 }, { avoidOverlap: true });
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-3 py-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Node library
        </p>
        <div className="relative mt-2">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search nodes"
            aria-label="Search nodes"
            className="h-7 pl-7 text-xs"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {groups.length === 0 ? (
          <p className="text-xs text-muted-foreground">No nodes match “{query}”.</p>
        ) : (
          <div className="space-y-4">
            {groups.map((group) => (
              <div key={group.category.id}>
                <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {group.category.label}
                </p>
                <div className="space-y-1">
                  {group.nodeTypes.map((meta) => {
                    const Icon = ICONS[meta.icon] ?? Layers;
                    return (
                      <button
                        key={meta.type}
                        type="button"
                        draggable
                        onDragStart={(event) => {
                          event.dataTransfer.setData(NODE_DRAG_MIME, meta.type);
                          event.dataTransfer.effectAllowed = "move";
                        }}
                        onClick={() => addNode(meta.type)}
                        title={meta.help}
                        data-testid={`node-library-item-${meta.type}`}
                        className="group flex w-full cursor-grab items-start gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors hover:border-border hover:bg-muted/60 active:cursor-grabbing"
                      >
                        <span
                          className="mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded"
                          style={{ backgroundColor: `${meta.accent}1f`, color: meta.accent }}
                        >
                          <Icon className="h-3 w-3" />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-medium leading-4">
                            {meta.label}
                          </span>
                          <span className="block truncate text-[10.5px] leading-4 text-muted-foreground">
                            {meta.description}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="border-t px-3 py-2 text-[10.5px] leading-4 text-muted-foreground">
        Drag onto the canvas, or click to place. {nodeCount} node
        {nodeCount === 1 ? "" : "s"} on canvas.
      </p>
    </div>
  );
}
