import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { AppError } from "../errors.js";
import { ERROR_CODES } from "../constants.js";
import { STANDARD_QUESTS } from "./questService.js";

/**
 * Durable user profile contract (#134).
 *
 * Holds a wallet's explicitly editable profile fields. Every read and write is
 * scoped by `walletAddress` bound to the authenticated principal, so one wallet
 * can never read or mutate another wallet's profile.
 *
 * Achievements are never stored on the profile. They are derived on every read
 * from the authoritative `user_quests` records (only quests a wallet has
 * actually completed). The profile's `badgeId` - the badge chosen for display -
 * is validated against that wallet's completed quests, so a badge can never be
 * granted by static UI data: it must already be earned.
 */

/** Achievements derived solely from authoritative quest records. */
export interface ProfileAchievement {
  questId: string;
  title: string;
  description: string;
  completedAt: Date | null;
}

export interface UserProfileView {
  walletAddress: string;
  displayName: string | null;
  bio: string | null;
  badgeId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserProfileWithAchievements extends UserProfileView {
  achievements: ProfileAchievement[];
}

export interface UpdateProfileFields {
  displayName?: string | null;
  bio?: string | null;
  badgeId?: string | null;
}

export class ProfileService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Returns the wallet's profile together with achievements derived from its
   * authoritative quest records. A wallet with no profile still gets an empty
   * (unpersisted) view plus its achievements, so the caller can always render.
   */
  async getProfile(walletAddress: string): Promise<UserProfileWithAchievements> {
    const [profile, quests] = await Promise.all([
      this.prisma.userProfile.findUnique({ where: { walletAddress } }),
      this.prisma.userQuest.findMany({ where: { walletAddress } })
    ]);

    const achievements = this.deriveAchievements(quests);

    return {
      walletAddress,
      displayName: profile?.displayName ?? null,
      bio: profile?.bio ?? null,
      badgeId: profile?.badgeId ?? null,
      createdAt: profile?.createdAt ?? new Date(0),
      updatedAt: profile?.updatedAt ?? new Date(0),
      achievements
    };
  }

  /**
   * Creates or updates the wallet's profile with only the explicitly editable
   * fields. `walletAddress` is never editable here - it is always taken from
   * the authenticated principal. Throws CONFLICT when a normalized display
   * name is already held by a different wallet, and INVALID_PAYLOAD when a
   * requested badge was not earned by this wallet.
   */
  async updateProfile(
    walletAddress: string,
    fields: UpdateProfileFields
  ): Promise<UserProfileWithAchievements> {
    const existing = await this.prisma.userProfile.findUnique({ where: { walletAddress } });

    const nextDisplayName = fields.displayName === undefined
      ? existing?.displayName ?? null
      : this.normalizeForStore(fields.displayName);
    const nextBadgeId = fields.badgeId === undefined
      ? existing?.badgeId ?? null
      : fields.badgeId;

    // A requested display identity must not already belong to another account.
    await this.assertDisplayNameAvailable(walletAddress, nextDisplayName);

    // The displayed badge must be one the wallet has actually earned.
    if (nextBadgeId !== null) {
      await this.assertBadgeEarned(walletAddress, nextBadgeId);
    }

    try {
      await this.prisma.userProfile.upsert({
        where: { walletAddress },
        create: {
          walletAddress,
          displayName: nextDisplayName,
          bio: fields.bio === undefined ? existing?.bio ?? null : this.coerceBio(fields.bio),
          badgeId: nextBadgeId
        },
        update: {
          displayName: nextDisplayName,
          bio: fields.bio === undefined ? existing?.bio ?? null : this.coerceBio(fields.bio),
          badgeId: nextBadgeId
        }
      });

      return this.getProfile(walletAddress);
    } catch (err) {
      // Backstop for the case-insensitive uniqueness check: a concurrent write
      // may slip in between the check and the upsert, surfacing as P2002 on
      // the unique display_name index.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw AppError.conflict(
          ERROR_CODES.CONFLICT,
          "that display name is already taken by another account"
        );
      }
      throw err;
    }
  }

  /**
   * Derives achievements from the wallet's authoritative `user_quests` rows.
   * Only quests that have reached `completed` status are returned; nothing is
   * granted from static data. Titles/descriptions come from the authoritative
   * quest catalog, never from a hardcoded "unlocked" list.
   */
  private deriveAchievements(
    quests: Array<{
      questId: string;
      status: string;
      completedAt: Date | null;
    }>
  ): ProfileAchievement[] {
    const catalog = new Map(STANDARD_QUESTS.map((q) => [q.id, q]));
    return quests
      .filter((q) => q.status === "completed")
      .sort((a, b) => (a.completedAt?.getTime() ?? 0) - (b.completedAt?.getTime() ?? 0))
      .map((q) => {
        const def = catalog.get(q.questId);
        return {
          questId: q.questId,
          title: def?.title ?? q.questId,
          description: def?.description ?? "",
          completedAt: q.completedAt
        };
      });
  }

  private normalize(value: string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed.toLowerCase();
  }

  private normalizeForStore(value: string | null | undefined): string | null {
    const t = value?.trim();
    return t && t.length > 0 ? t : null;
  }

  private coerceBio(value: string | null | undefined): string | null {
    const t = value?.trim();
    return t && t.length > 0 ? t : null;
  }

  private async assertDisplayNameAvailable(
    walletAddress: string,
    displayName: string | null
  ): Promise<void> {
    if (!displayName) return;
    const normalized = this.normalize(displayName);
    if (!normalized) return;

    const all = await this.prisma.userProfile.findMany({
      where: { displayName: { not: null } },
      select: { walletAddress: true, displayName: true }
    });

    const conflict = all.find(
      (p) => p.walletAddress !== walletAddress && p.displayName != null &&
        this.normalize(p.displayName) === normalized
    );

    if (conflict) {
      throw AppError.conflict(
        ERROR_CODES.CONFLICT,
        "that display name is already taken by another account"
      );
    }
  }

  private async assertBadgeEarned(walletAddress: string, badgeId: string): Promise<void> {
    const quest = await this.prisma.userQuest.findUnique({
      where: { walletAddress_questId: { walletAddress, questId: badgeId } },
      select: { status: true }
    });

    if (!quest || quest.status !== "completed") {
      throw AppError.validation(
        `badge_id must reference a quest the wallet has completed: ${badgeId}`
      );
    }
  }
}
