import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuthProvider, type AuthUser } from "./index";

/**
 * Server-side Data Access Layer: resolve the signed-in user for the current
 * request. Redirects to /login when unauthenticated.
 *
 * NOTE (Next 16 Cache Components): calling this from a page must happen
 * inside a <Suspense> boundary — the session read is request-dependent.
 */
export async function getCurrentUser(): Promise<AuthUser> {
  const session = await getAuthProvider().getSession(await headers());
  if (session === null) {
    redirect("/login");
  }
  return session.user;
}
