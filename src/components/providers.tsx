"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState, type ReactNode } from "react";

/**
 * Client-side providers.
 *
 * - TanStack Query owns server state in the UI (health polling today,
 *   run/experiment data later). Editor-local state lives in Zustand stores
 *   inside each module.
 * - Theme: the product is dark-first — the landing page's black canvas sets
 *   the brand, and the authenticated app defaults to the matching dark theme.
 *   The choice persists in localStorage; transitions are disabled so switching
 *   never flashes mid-paint. The landing page is unaffected: its palette is
 *   scoped under `.landing` and does not depend on the theme class.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false} disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </ThemeProvider>
  );
}
