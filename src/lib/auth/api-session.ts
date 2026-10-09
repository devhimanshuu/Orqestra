import { headers } from "next/headers";
import { UnauthorizedError } from "@/lib/errors";
import { ensureLocalUser } from "@/modules/users/user.service";
import { getAuthProvider, type AuthUser } from "./index";

/**
 * Session access for route handlers and server components.
 *
 * `getApiUser` returns null for anonymous requests; `requireApiUser` throws
 * UnauthorizedError, which toErrorResponse() maps to a 401.
 *
 * Both provision the identity locally first (see ensureLocalUser) so services
 * can rely on a `public."User"` row for every authenticated caller.
 */
export async function getApiUser(): Promise<AuthUser | null> {
  const session = await getAuthProvider().getSession(await headers());
  if (session === null) {
    return null;
  }
  await ensureLocalUser(session.user);
  return session.user;
}

export async function requireApiUser(): Promise<AuthUser> {
  const user = await getApiUser();
  if (user === null) {
    throw new UnauthorizedError();
  }
  return user;
}
