"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Copy-to-clipboard field for the hero.
 *
 * The landing page's equivalent of "copy the setup prompt": the harness
 * definition the runtime actually compiles, on the clipboard in one click. The
 * value is passed in as a string, so the page stays a server component.
 */
export function CopyField({
  label,
  value,
  hint,
  className,
}: {
  /** Mono caption above the field (uppercase, letter-spaced). */
  label: string;
  /** Text placed on the clipboard. */
  value: string;
  /** Row text next to the icons. */
  hint: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) {
        clearTimeout(resetTimer.current);
      }
    },
    [],
  );

  const copy = async (): Promise<void> => {
    try {
      if (navigator.clipboard?.writeText !== undefined) {
        await navigator.clipboard.writeText(value);
      } else {
        // Older browsers: a hidden textarea + execCommand still works.
        const area = document.createElement("textarea");
        area.value = value;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }
      setCopied(true);
      setFailed(false);
    } catch {
      setFailed(true);
    }
    if (resetTimer.current !== null) {
      clearTimeout(resetTimer.current);
    }
    resetTimer.current = setTimeout(() => setCopied(false), 2_000);
  };

  return (
    <div className={cn("w-full border border-[var(--home-border)] bg-[var(--home-bg)]", className)}>
      <p className="landing-mono border-b border-[var(--home-border)] px-3 py-2 text-[10.5px] tracking-[0.14em] text-[var(--home-text-faint)] uppercase">
        {label}
      </p>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={`Copy: ${hint}`}
        className="group flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-white/[0.03]"
      >
        <span
          aria-hidden="true"
          className="flex items-center gap-1.5 text-[var(--home-text-faint)]"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
          >
            <path d="M12 3 4 7v10l8 4 8-4V7z" strokeLinejoin="round" />
            <path d="M4 7l8 4 8-4M12 21V11" strokeLinejoin="round" />
          </svg>
          <svg
            viewBox="0 0 24 24"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
          >
            <circle cx="12" cy="12" r="3.2" />
            <path
              d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M19 5l-3 3M8 16l-3 3"
              strokeLinecap="round"
            />
          </svg>
        </span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] text-[var(--home-text)]">
          {failed ? "Clipboard blocked — select the definition in the builder instead" : hint}
        </span>
        <span
          aria-hidden="true"
          className="flex items-center gap-1.5 text-[var(--home-text-faint)] transition-colors group-hover:text-[var(--home-text)]"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          <span className="landing-mono text-[10px] tracking-[0.14em] uppercase">
            {copied ? "Copied" : "Copy"}
          </span>
        </span>
      </button>
    </div>
  );
}
