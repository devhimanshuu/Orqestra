"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Info, Trash2 } from "lucide-react";
import { getHandleSpec } from "@/modules/harness/harness.schema";
import { getFieldSpecs, MODEL_OPTIONS, type FieldSpec } from "@/modules/harness/editor/field-specs";
import { NODE_CATALOG } from "@/modules/harness/editor/node-catalog";
import { useEditorStore, useSelectedNode } from "@/modules/harness/editor/editor-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * Node inspector.
 *
 * Fields come from the per-type field specs; validity comes from the node's own
 * Zod config schema (via the store's `fieldErrors`). Editing writes straight to
 * the store, so autosave and validation react without an explicit "apply".
 */
export function InspectorPanel() {
  const node = useSelectedNode();
  const updateNode = useEditorStore((state) => state.updateNode);
  const updateNodeConfig = useEditorStore((state) => state.updateNodeConfig);
  const removeNodes = useEditorStore((state) => state.removeNodes);
  const nodeCount = useEditorStore((state) => state.nodes.length);

  if (!node) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-xs font-medium">No node selected</p>
        <p className="text-[11px] leading-4 text-muted-foreground">
          Select a node on the canvas to configure it, or drop one in from the node library.
        </p>
        {nodeCount === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            The canvas is empty — add a Start node to begin.
          </p>
        ) : null}
      </div>
    );
  }

  const meta = NODE_CATALOG[node.data.nodeType];
  const fields = getFieldSpecs(node.data.nodeType);
  const handles = getHandleSpec(node.data.nodeType);

  function setConfig(key: string, value: unknown) {
    const current = useEditorStore.getState().nodes.find((item) => item.id === node?.id);
    if (!current) {
      return;
    }
    const next = { ...current.data.config };
    if (value === "" || value === undefined || value === null) {
      delete next[key];
    } else {
      next[key] = value;
    }
    updateNodeConfig(current.id, next);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start gap-2 border-b px-3 py-2.5">
        <span
          className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px] font-semibold"
          style={{ backgroundColor: `${meta.accent}1f`, color: meta.accent }}
        >
          {meta.label.slice(0, 1)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold">{meta.label}</p>
          <p className="font-mono text-[10px] text-muted-foreground">
            {node.id} · {node.data.nodeType}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground hover:text-destructive"
          title="Delete node"
          aria-label="Delete node"
          onClick={() => removeNodes([node.id])}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-3 py-3">
        <div className="space-y-1.5">
          <Label htmlFor="node-label" className="text-[11px]">
            Name
          </Label>
          <Input
            id="node-label"
            value={node.data.label}
            maxLength={120}
            data-testid="inspector-node-label"
            onChange={(event) => updateNode(node.id, { label: event.target.value })}
            className="h-7 text-xs"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="node-description" className="text-[11px]">
            Description
          </Label>
          <Textarea
            id="node-description"
            value={node.data.description}
            maxLength={500}
            rows={2}
            data-testid="inspector-node-description"
            onChange={(event) => updateNode(node.id, { description: event.target.value })}
            className="text-xs"
          />
        </div>

        {fields.length > 0 ? (
          <>
            <Separator />
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Configuration
            </p>
            <div className="grid grid-cols-2 gap-3">
              {fields
                .filter((field) => !field.visibleWhen || field.visibleWhen(node.data.config))
                .map((field) => (
                  <InspectorField
                    key={field.key}
                    field={field}
                    value={node.data.config[field.key]}
                    error={node.data.fieldErrors[field.key]}
                    onChange={(value) => setConfig(field.key, value)}
                  />
                ))}
            </div>
          </>
        ) : (
          <>
            <Separator />
            <p className="flex items-start gap-1.5 rounded-md bg-muted/60 px-2 py-1.5 text-[11px] leading-4 text-muted-foreground">
              <Info className="mt-0.5 h-3 w-3 shrink-0" />
              {meta.type === "start"
                ? "The start node has no configuration; it marks where execution begins."
                : "The end node has no configuration; it returns the run output."}
            </p>
          </>
        )}

        <Separator />

        <dl className="space-y-1.5 text-[11px]">
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Category</dt>
            <dd className="font-medium capitalize">{meta.category}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Inputs</dt>
            <dd className="font-medium">{handles.input ? 1 : 0}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Outputs</dt>
            <dd className="font-medium">
              {handles.outputs.filter((output) => output !== "").length || handles.outputs.length}
            </dd>
          </div>
          {node.data.configInvalid ? (
            <div className="flex justify-between gap-2 text-destructive">
              <dt>Configuration</dt>
              <dd className="font-medium">Incomplete</dd>
            </div>
          ) : (
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Configuration</dt>
              <dd className="font-medium text-emerald-600 dark:text-emerald-400">Valid</dd>
            </div>
          )}
        </dl>

        <p className="rounded-md border border-dashed px-2 py-1.5 text-[10.5px] leading-4 text-muted-foreground">
          {meta.help}
        </p>
      </div>
    </div>
  );
}

interface InspectorFieldProps {
  field: FieldSpec;
  value: unknown;
  error?: string | undefined;
  onChange: (value: unknown) => void;
}

/** One config field. Text-like inputs commit on blur to keep history entries coarse. */
function InspectorField({ field, value, error, onChange }: InspectorFieldProps) {
  const inputId = `field-${field.key}`;
  const isNumber = field.kind === "number";
  const stringValue = value === undefined || value === null ? "" : String(value);
  const [draft, setDraft] = useState(stringValue);
  const committed = useRef(stringValue);

  useEffect(() => {
    if (committed.current !== stringValue) {
      committed.current = stringValue;
      setDraft(stringValue);
    }
  }, [stringValue]);

  const datalistId = useMemo(
    () => (field.key === "model" ? "orqestra-model-options" : undefined),
    [field.key],
  );

  function commit(raw: string) {
    if (isNumber) {
      if (raw.trim() === "") {
        committed.current = "";
        onChange("");
        return;
      }
      const parsed = Number(raw);
      if (Number.isNaN(parsed)) {
        setDraft(committed.current);
        return;
      }
      committed.current = String(parsed);
      onChange(parsed);
      return;
    }
    committed.current = raw;
    onChange(raw);
  }

  const shared = {
    id: inputId,
    "data-testid": `inspector-field-${field.key}`,
    "aria-invalid": error ? true : undefined,
    className: cn("h-7 text-xs", error && "border-destructive focus-visible:ring-destructive"),
    placeholder: field.placeholder,
    onBlur: (event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      commit(event.target.value),
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.key === "Enter" && field.kind !== "textarea") {
        commit((event.target as HTMLInputElement).value);
        (event.target as HTMLInputElement).blur();
      }
      if (event.key === "Escape") {
        setDraft(committed.current);
        (event.target as HTMLInputElement).blur();
      }
    },
  };

  return (
    <div className={cn("space-y-1.5", field.half ? "col-span-1" : "col-span-2")}>
      <Label htmlFor={inputId} className="text-[11px]">
        {field.label}
      </Label>

      {field.kind === "textarea" ? (
        <Textarea
          {...shared}
          value={draft}
          rows={field.rows ?? 4}
          onChange={(event) => setDraft(event.target.value)}
        />
      ) : field.kind === "select" ? (
        <select
          id={inputId}
          data-testid={`inspector-field-${field.key}`}
          value={stringValue}
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            committed.current = event.target.value;
            onChange(event.target.value);
          }}
          className={cn(
            "h-7 w-full rounded-md border bg-transparent px-2 text-xs shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
            error && "border-destructive",
          )}
        >
          <option value="">—</option>
          {field.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <Input
          {...shared}
          type={isNumber ? "number" : "text"}
          inputMode={isNumber ? "decimal" : undefined}
          list={datalistId}
          value={draft}
          min={field.min}
          max={field.max}
          step={field.step}
          onChange={(event) => setDraft(event.target.value)}
        />
      )}

      {datalistId ? (
        <datalist id={datalistId}>
          {MODEL_OPTIONS.map((option) => (
            <option key={option.value} value={option.value} />
          ))}
        </datalist>
      ) : null}

      {error ? (
        <p className="text-[10.5px] leading-4 text-destructive">{error}</p>
      ) : field.help ? (
        <p className="text-[10.5px] leading-4 text-muted-foreground">{field.help}</p>
      ) : null}
    </div>
  );
}
