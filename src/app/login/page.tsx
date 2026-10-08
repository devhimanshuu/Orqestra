import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { LoginForm } from "@/components/login-form";
import { getAuthProvider } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Sign in",
};

/**
 * Session reads are request-dependent, so they stream inside a Suspense
 * boundary (required by Next 16 Cache Components).
 */
async function RedirectIfSignedIn(): Promise<null> {
  const session = await getAuthProvider().getSession(await headers());
  if (session !== null) {
    redirect("/dashboard");
  }
  return null;
}

export default function LoginPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <Suspense fallback={null}>
        <RedirectIfSignedIn />
      </Suspense>
      <LoginForm />
    </main>
  );
}
