"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  Database,
  Gauge,
  GitBranch,
  Layers,
  ListTree,
  MessageSquare,
  Play,
  Repeat,
  ShieldCheck,
  Shuffle,
  Sparkles,
  Split,
  Square,
  UserCheck,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { getHandleSpec } from "@/modules/harness/harness.schema";
import { NODE_CATALOG } from "@/modules/harness/editor/node-catalog";
import type { HarnessCanvasNode } from "@/modules/harness/editor/react-flow-adapter";
import { cn } from "@/lib/utils";

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

const BRANCH_LABELS: Record<string, string> = {
  true: "True",
  false: "False",
  body: "Body",
  exit: "Done",
};

/**
 * Canvas node card. Kept deliberately compact (fixed width, 1–2 line summary) so
 * a 30-node harness stays readable, and memoized so dragging one node does not
 * re-render the rest of the graph.
 */
export const HarnessNodeCard = memo(function HarnessNodeCard({
  data,
  selected,
}: NodeProps<HarnessCanvasNode>) {
  const meta = NODE_CATALOG[data.nodeType];
  const Icon = ICONS[meta.icon] ?? Layers;
  const handles = getHandleSpec(data.nodeType);
  const namedBranches = handles.outputs.filter((output) => output !== "");
  const hasIssues = data.errorCount > 0 || data.configInvalid;

  return (
    <div
      className={cn(
        "group w-[210px] rounded-lg border bg-card text-card-foreground shadow-sm transition-shadow",
        "hover:shadow-md",
        selected ? "border-primary ring-2 ring-primary/30" : "border-border",
        hasIssues && !selected && "border-destructive/60",
      )}
      data-testid={`node-${data.nodeType}`}
      data-node-label={data.label}
    >
      {handles.input ? (
        <Handle
          type="target"
          position={Position.Top}
          className="!h-2 !w-2 !border !border-background !bg-muted-foreground"
        />
      ) : null}

      <div className="flex items-center gap-2 border-b px-2.5 py-1.5">
        <span
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded"
          style={{ backgroundColor: `${meta.accent}1f`, color: meta.accent }}
        >
          <Icon className="h-3 w-3" />
        </span>
        <span className="truncate text-[12px] font-medium leading-none">{data.label}</span>
        {hasIssues ? (
          <span
            className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground"
            title={data.configInvalid ? "Configuration incomplete" : "Graph problems"}
          >
            {Math.max(data.errorCount, data.configInvalid ? 1 : 0)}
          </span>
        ) : (
          <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500/70" />
        )}
      </div>

      <div className="px-2.5 py-1.5">
        <p className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
          {data.description || meta.description}
        </p>
      </div>

      {namedBranches.length > 0 ? (
        <div className="flex items-center justify-between border-t px-2.5 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          {namedBranches.map((branch) => (
            <span key={branch} className="flex items-center gap-1">
              {BRANCH_LABELS[branch] ?? branch}
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: meta.accent }} />
            </span>
          ))}
        </div>
      ) : handles.outputs.length > 0 ? (
        <Handle
          type="source"
          position={Position.Bottom}
          className="!h-2 !w-2 !border !border-background !bg-muted-foreground"
        />
      ) : null}

      {namedBranches.map((branch, index) => (
        <Handle
          key={branch}
          id={branch}
          type="source"
          position={Position.Bottom}
          style={{
            left: `${((index + 1) / (namedBranches.length + 1)) * 100}%`,
            backgroundColor: meta.accent,
          }}
          className="!h-2 !w-2 !border !border-background"
        />
      ))}
    </div>
  );
});
