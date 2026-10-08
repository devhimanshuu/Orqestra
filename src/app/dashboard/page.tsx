import type { Metadata } from "next";
import { Suspense } from "react";
import { SignOutButton } from "@/components/sign-out-button";
import { SystemStatus } from "@/components/system-status";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentUser } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "Dashboard",
};

/**
 * Phase 0 proves the wiring — Next.js → Authentication → Database → Redis → API —
 * and nothing more. The harness editor arrives in Phase 1.
 */
async function SessionCard() {
  const user = await getCurrentUser();
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle>Signed in</CardTitle>
            <CardDescription>{user.email}</CardDescription>
          </div>
          <SignOutButton />
        </div>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        <p>
          {user.name} · user id <code className="font-mono text-xs">{user.id}</code>
        </p>
        <p className="mt-1">
          Session resolved through the AuthProvider abstraction (Better Auth + PostgreSQL).
        </p>
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-12">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Orqestra</h1>
        <p className="text-sm text-muted-foreground">
          Phase 0 foundation — authentication, database, queue infrastructure, and API health.
        </p>
      </header>

      <Suspense
        fallback={
          <Card>
            <CardContent className="py-6 text-sm text-muted-foreground">
              Resolving session…
            </CardContent>
          </Card>
        }
      >
        <SessionCard />
      </Suspense>

      <SystemStatus />

      <Card>
        <CardHeader>
          <CardTitle>Next</CardTitle>
          <CardDescription>Deliberately out of scope for Phase 0.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Visual harness builder (Phase 1), agent runtime (Phase 2), run lab &amp; tracing (Phase
          3), evaluation (4), versioning &amp; A/B testing (5), experiments (6), loop engineering
          (7), harness optimization (8), self-evolving harnesses (9).
        </CardContent>
      </Card>
    </main>
  );
}
