import { getPrisma } from "@/lib/db/prisma";

/**
 * Local mirror of an auth identity.
 *
 * With hosted Neon Auth the authoritative user rows live in the `neon_auth`
 * schema, which our Prisma models do not own. Domain tables (workspace
 * membership, `createdBy` attribution) still need a `public."User"` row, so
 * the app mirrors each authenticated identity under the *same id* — the hosted
 * user id — which keeps a single source of identity across both schemas.
 */
export interface LocalUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  createdAt: Date;
}

export const userRepository = {
  async findById(id: string): Promise<LocalUser | null> {
    return getPrisma().user.findUnique({
      where: { id },
      select: { id: true, email: true, name: true, emailVerified: true, createdAt: true },
    });
  },

  async findByEmail(email: string): Promise<LocalUser | null> {
    return getPrisma().user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true, emailVerified: true, createdAt: true },
    });
  },

  async create(user: LocalUser): Promise<LocalUser> {
    return getPrisma().user.create({
      data: {
        id: user.id,
        email: user.email,
        name: user.name,
        emailVerified: user.emailVerified,
      },
      select: { id: true, email: true, name: true, emailVerified: true, createdAt: true },
    });
  },

  async updateProfile(id: string, profile: { email: string; name: string }): Promise<void> {
    await getPrisma().user.update({
      where: { id },
      data: { email: profile.email, name: profile.name },
    });
  },

  /**
   * Identity adoption — one-time migration for rows created before the app
   * moved to hosted Neon Auth (Phase 0 seeded credentials locally, so a row
   * with the same email can already exist under a different id).
   *
   * The email is freed first (the local row keeps its login only through the
   * auth provider now), then the hosted identity takes over the row's
   * memberships and attribution, and the legacy row is removed. Runs inside a
   * transaction so an interrupted adoption cannot lose tenancy rows.
   */
  async adoptIdentity(input: { legacyId: string; hosted: LocalUser }): Promise<void> {
    const { legacyId, hosted } = input;
    await getPrisma().$transaction(async (tx) => {
      // Park the email on a reserved address: `password`/session rows of the
      // legacy identity are meaningless once the hosted instance owns auth.
      await tx.user.update({
        where: { id: legacyId },
        data: { email: `legacy+${legacyId}@orqestra.invalid` },
      });
      await tx.user.create({
        data: {
          id: hosted.id,
          email: hosted.email,
          name: hosted.name,
          emailVerified: hosted.emailVerified,
        },
      });
      await tx.workspaceMember.updateMany({
        where: { userId: legacyId },
        data: { userId: hosted.id },
      });
      await tx.agentVersion.updateMany({
        where: { createdBy: legacyId },
        data: { createdBy: hosted.id },
      });
      await tx.harnessVersion.updateMany({
        where: { createdBy: legacyId },
        data: { createdBy: hosted.id },
      });
      await tx.harnessDraft.updateMany({
        where: { updatedBy: legacyId },
        data: { updatedBy: hosted.id },
      });
      // Local Session/Account rows belong to the retired credential store.
      await tx.session.deleteMany({ where: { userId: legacyId } });
      await tx.account.deleteMany({ where: { userId: legacyId } });
      await tx.user.delete({ where: { id: legacyId } });
    });
  },
};
