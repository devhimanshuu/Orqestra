import { Prisma } from "@/generated/prisma/client";
import type { AuthUser } from "@/lib/auth/provider";
import { logger } from "@/lib/logging/logger";
import { userRepository, type LocalUser } from "./user.repository";

/**
 * Provisioning: guarantees that an authenticated identity has a local
 * `public."User"` row before any domain code runs.
 *
 * Called from the session boundary (see src/lib/auth/session.ts and
 * api-session.ts), so every page and route handler can assume the invariant
 * "authenticated user ⇒ local row exists" — which is what workspace
 * membership, `createdBy`, and authorization guards rely on.
 *
 * The happy path costs one primary-key lookup.
 */
export async function ensureLocalUser(authUser: AuthUser): Promise<LocalUser> {
  const existing = await userRepository.findById(authUser.id);
  if (existing !== null) {
    return existing;
  }

  const hosted: LocalUser = {
    id: authUser.id,
    email: authUser.email,
    name: authUser.name,
    emailVerified: authUser.emailVerified,
    createdAt: authUser.createdAt,
  };

  // A row with this email already exists under a different id: either an
  // adoption from the pre-hosted-auth era, or a data anomaly. Adopt when it
  // looks like the former (same email, no row for the hosted id).
  const byEmail = await userRepository.findByEmail(authUser.email);
  if (byEmail !== null && byEmail.id !== authUser.id) {
    logger.warn("adopting local user row for hosted identity", {
      legacyId: byEmail.id,
      hostedId: authUser.id,
    });
    await userRepository.adoptIdentity({ legacyId: byEmail.id, hosted });
    return hosted;
  }

  try {
    const created = await userRepository.create(hosted);
    logger.info("local user provisioned", { userId: created.id });
    return created;
  } catch (error) {
    // Concurrent first requests (e.g. parallel page + API calls) can race to
    // create the same row; the loser simply reads the winner's row.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const row = await userRepository.findById(authUser.id);
      if (row !== null) {
        return row;
      }
    }
    throw error;
  }
}
