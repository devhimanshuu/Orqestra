import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { getCurrentUser } from "@/lib/auth/session";
import { workspaceRepository } from "@/modules/projects/workspace.repository";

/**
 * Authenticated application shell.
 *
 * Every page under /dashboard renders inside the AppShell (grouped sidebar,
 * top bar, command palette). The builder route opts out internally via
 * pathname detection — it is a full-screen engineering workspace.
 *
 * Session reads are request-dependent, so they stream inside Suspense
 * (required by Next 16 Cache Components).
 */
async function ShellData({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  const workspace = await workspaceRepository.findFirstForUser(user.id).catch(() => null);

  return (
    <AppShell
      user={{ name: user.name, email: user.email }}
      workspace={workspace ? { name: workspace.name, slug: workspace.slug } : null}
    >
      {children}
    </AppShell>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-dvh items-center justify-center">
          <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <p>Loading Orqestra…</p>
          </div>
        </div>
      }
    >
      <ShellData>{children}</ShellData>
    </Suspense>
  );
}
