"use client";

import { AlertTriangle, CheckCircle2, CircleDashed, Wand2 } from "lucide-react";
import { NODE_CATALOG } from "@/modules/harness/editor/node-catalog";
import { useEditorStore } from "@/modules/harness/editor/editor-store";
import type { HarnessCanvasNode } from "@/modules/harness/editor/react-flow-adapter";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Validation panel.
 *
 * Every issue is actionable: clicking one selects and reveals the offending node
 * (or the node the edge belongs to). Issues without a node are grouped as graph
 * level problems.
 */
export function ValidationPanel({ onValidate }: { onValidate: () => void }) {
  const issues = useEditorStore((state) => state.issues);
  const status = useEditorStore((state) => state.validationStatus);
  const validatedAt = useEditorStore((state) => state.validatedAt);
  const nodes = useEditorStore((state) => state.nodes);
  const focusNode = useEditorStore((state) => state.focusNode);
  const setPanel = useEditorStore((state) => state.setPanel);

  const nodeIssues = issues.filter((issue) => issue.nodeId);
  const graphIssues = issues.filter((issue) => !issue.nodeId);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2.5">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Validation
          </p>
          <p className="text-[11px] text-muted-foreground" data-testid="validation-summary">
            {status === "unknown"
              ? "Not validated yet"
              : status === "valid"
                ? "Harness is valid"
                : `Harness has ${issues.length} problem${issues.length === 1 ? "" : "s"}`}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-[11px]"
          onClick={onValidate}
          data-testid="validate-button"
        >
          <Wand2 className="h-3 w-3" />
          Validate
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {status === "valid" ? (
          <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-2">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
            <div className="text-[11px] leading-4">
              <p className="font-medium text-emerald-700 dark:text-emerald-400">
                No problems found
              </p>
              <p className="text-muted-foreground">
                {nodes.length} node{nodes.length === 1 ? "" : "s"} validated against the harness
                rules. You can publish this draft as a version.
              </p>
            </div>
          </div>
        ) : null}

        {status === "invalid" ? (
          <div className="space-y-4">
            {graphIssues.length > 0 ? (
              <IssueGroup title="Graph">
                {graphIssues.map((issue, index) => (
                  <IssueRow
                    key={`${issue.code}-${index}`}
                    code={issue.code}
                    message={issue.message}
                  />
                ))}
              </IssueGroup>
            ) : null}

            {nodeIssues.length > 0 ? (
              <IssueGroup title="Nodes">
                {nodeIssues.map((issue, index) => (
                  <IssueRow
                    key={`${issue.code}-${index}`}
                    code={issue.code}
                    message={issue.message}
                    nodeLabel={labelFor(nodes, issue.nodeId)}
                    onFocus={issue.nodeId ? () => focusNode(issue.nodeId!) : undefined}
                  />
                ))}
              </IssueGroup>
            ) : null}
          </div>
        ) : null}

        {status === "unknown" ? (
          <div className="space-y-2 text-[11px] leading-4 text-muted-foreground">
            <p className="flex items-center gap-1.5">
              <CircleDashed className="h-3.5 w-3.5" />
              Editing the graph reruns validation automatically.
            </p>
            <p>
              Rules include: exactly one start node, at least one end node, every node reachable
              from start, every node able to reach an end, valid handles, and cycles only through a
              loop node.
            </p>
          </div>
        ) : null}
      </div>

      <div className="border-t px-3 py-2 text-[10.5px] text-muted-foreground">
        {validatedAt ? `Last checked ${new Date(validatedAt).toLocaleTimeString()}` : "Not checked"}
        <button
          type="button"
          className="ml-2 underline underline-offset-2 hover:text-foreground"
          onClick={() => setPanel("versions")}
        >
          Go to versions
        </button>
      </div>
    </div>
  );
}

function labelFor(nodes: HarnessCanvasNode[], nodeId: string | undefined): string | undefined {
  if (!nodeId) {
    return undefined;
  }
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) {
    return nodeId;
  }
  return `${node.data.label} (${NODE_CATALOG[node.data.nodeType].label})`;
}

function IssueGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      <ul className="space-y-1.5">{children}</ul>
    </div>
  );
}

interface IssueRowProps {
  code: string;
  message: string;
  nodeLabel?: string | undefined;
  onFocus?: (() => void) | undefined;
}

function IssueRow({ code, message, nodeLabel, onFocus }: IssueRowProps) {
  const content = (
    <span className="flex items-start gap-2">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] font-medium leading-4">{message}</span>
        <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground">
          {code}
          {nodeLabel ? ` · ${nodeLabel}` : ""}
        </span>
      </span>
    </span>
  );

  if (!onFocus) {
    return (
      <li className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2">
        {content}
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        onClick={onFocus}
        data-testid={`validation-issue-${code}`}
        className={cn(
          "w-full rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-left transition-colors",
          "hover:border-destructive/60 hover:bg-destructive/10",
        )}
      >
        {content}
      </button>
    </li>
  );
}
