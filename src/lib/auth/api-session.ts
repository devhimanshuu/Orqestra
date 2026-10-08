import { headers } from "next/headers";
import { UnauthorizedError } from "@/lib/errors";
import { getAuthProvider, type AuthUser } from "./index";

/**
 * Session access for route handlers and server components.
 *
 * `getApiUser` returns null for anonymous requests; `requireApiUser` throws
 * UnauthorizedError, which toErrorResponse() maps to a 401.
 */
export async function getApiUser(): Promise<AuthUser | null> {
  const session = await getAuthProvider().getSession(await headers());
  return session?.user ?? null;
}

export async function requireApiUser(): Promise<AuthUser> {
  const user = await getApiUser();
  if (user === null) {
    throw new UnauthorizedError();
  }
  return user;
}
