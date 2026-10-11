"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * Config editor for a configured evaluator.
 *
 * The server validates every configuration against the kind's strict schema, so
 * this editor's job is only to collect a faithful representation: values are
 * held as raw text (never coerced while typing) and converted once, on submit.
 */

export interface EvaluatorConfigFieldDto {
  name: string;
  label: string;
  type: "string" | "number" | "boolean" | "string[]" | "model" | "json";
  required?: boolean;
  description?: string;
  default?: unknown;
}

export function defaultValueFor(field: EvaluatorConfigFieldDto): string {
  if (field.default === undefined) {
    return field.type === "boolean" ? "false" : "";
  }
  if (field.type === "string[]" && Array.isArray(field.default)) {
    return field.default.filter((entry): entry is string => typeof entry === "string").join(", ");
  }
  if (field.type === "json") {
    try {
      return JSON.stringify(field.default, null, 2);
    } catch {
      return "";
    }
  }
  return typeof field.default === "string" ? field.default : JSON.stringify(field.default);
}

export function initialRawConfig(
  fields: EvaluatorConfigFieldDto[],
  config?: Record<string, unknown>,
): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const field of fields) {
    const value = config?.[field.name];
    raw[field.name] = value === undefined ? defaultValueFor(field) : valueToRaw(field, value);
  }
  return raw;
}

function valueToRaw(field: EvaluatorConfigFieldDto, value: unknown): string {
  if (field.type === "string[]") {
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string").join(", ")
      : "";
  }
  if (field.type === "json") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return "";
    }
  }
  return value === null || value === undefined ? "" : String(value);
}

export function coerceRawConfig(
  fields: EvaluatorConfigFieldDto[],
  raw: Record<string, string>,
): { ok: true; config: Record<string, unknown> } | { ok: false; error: string } {
  const config: Record<string, unknown> = {};
  for (const field of fields) {
    const text = (raw[field.name] ?? "").trim();
    switch (field.type) {
      case "boolean":
        config[field.name] = text === "true";
        break;
      case "number": {
        if (text === "") {
          config[field.name] = 0;
          break;
        }
        const value = Number(text);
        if (!Number.isFinite(value)) {
          return { ok: false, error: `${field.label} must be a number` };
        }
        config[field.name] = value;
        break;
      }
      case "string[]":
        config[field.name] =
          text === ""
            ? []
            : text
                .split(",")
                .map((entry) => entry.trim())
                .filter((entry) => entry !== "");
        break;
      case "json": {
        if (text === "") {
          config[field.name] = {};
          break;
        }
        try {
          config[field.name] = JSON.parse(text) as unknown;
        } catch {
          return { ok: false, error: `${field.label} must be valid JSON` };
        }
        break;
      }
      default:
        config[field.name] = text;
    }
  }
  return { ok: true, config };
}

export function ConfigFieldsEditor({
  fields,
  raw,
  onChange,
  idPrefix,
}: {
  fields: EvaluatorConfigFieldDto[];
  raw: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  idPrefix: string;
}) {
  const set = (name: string, value: string): void => onChange({ ...raw, [name]: value });

  if (fields.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        This evaluator kind takes no configuration.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {fields.map((field) => {
        const id = `${idPrefix}-${field.name}`;
        return (
          <div key={field.name} className="flex flex-col gap-1.5">
            <Label htmlFor={id} className="flex items-center gap-1.5">
              {field.label}
              {field.required === true ? <span className="text-destructive">*</span> : null}
              <span className="font-mono text-[10px] text-muted-foreground">{field.name}</span>
            </Label>

            {field.type === "boolean" ? (
              <label className="flex items-center gap-2 text-sm">
                <input
                  id={id}
                  type="checkbox"
                  checked={raw[field.name] === "true"}
                  onChange={(event) => set(field.name, event.target.checked ? "true" : "false")}
                  className="h-4 w-4 rounded border"
                />
                <span className="text-xs text-muted-foreground">
                  {field.description ?? "Enabled"}
                </span>
              </label>
            ) : field.type === "json" ? (
              <Textarea
                id={id}
                value={raw[field.name] ?? ""}
                onChange={(event) => set(field.name, event.target.value)}
                rows={5}
                className="font-mono text-[11px]"
                placeholder={defaultValueFor(field) || "{}"}
              />
            ) : (
              <Input
                id={id}
                type={field.type === "number" ? "number" : "text"}
                value={raw[field.name] ?? ""}
                onChange={(event) => set(field.name, event.target.value)}
                placeholder={
                  field.type === "string[]"
                    ? "comma, separated"
                    : field.type === "model"
                      ? "provider:model"
                      : defaultValueFor(field)
                }
              />
            )}

            {field.type !== "boolean" && field.description !== undefined ? (
              <p className="text-[11px] text-muted-foreground">{field.description}</p>
            ) : null}
            {field.type === "string[]" && field.required !== true ? (
              <p className="text-[11px] text-muted-foreground">
                Comma-separated. Leave empty for no constraint.
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
