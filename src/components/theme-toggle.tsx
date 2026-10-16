"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";

/**
 * Dark/light switch. The app is dark-first (the landing page's canvas), so the
 * toggle offers the light theme as an alternative rather than the default.
 *
 * `resolvedTheme` only exists client-side. `typeof window` is false during SSR
 * *and* during hydration, so the first client render matches the server output
 * and the real icon appears on the post-hydration render — without a setState
 * effect.
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();

  if (typeof window === "undefined") {
    return (
      <Button variant="ghost" size="icon-sm" aria-label="Toggle theme" disabled>
        <Sun className="h-3.5 w-3.5" />
      </Button>
    );
  }

  const isDark = resolvedTheme === "dark";
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
    </Button>
  );
}
