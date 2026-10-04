import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AppError } from "../errors.js";
import { ERROR_CODES } from "../constants.js";
import type { PrivacyEncryptionService, EncryptedPayload } from "./privacy/privacyEncryptionService.js";

export const notificationPrefsSchema = z.object({
  roundUpdates: z.boolean(),
  actionStatus: z.boolean(),
  winnings: z.boolean(),
  deposits: z.boolean(),
  securityNotices: z.literal(true)
}).strict();

export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;
export const DEFAULT_NOTIFICATION_PREFS: Readonly<NotificationPrefs> = Object.freeze({
  roundUpdates: true,
  actionStatus: true,
  winnings: true,
  deposits: false,
  securityNotices: true
});
const CATEGORY = "notification_preferences";
const storedPrefsSchema = z.object({ version: z.literal(1), prefs: notificationPrefsSchema }).strict();

export type NotificationCategory = "action" | "round" | "prize" | "deposit" | "security";
const PREF_BY_CATEGORY = {
  action: "actionStatus",
  round: "roundUpdates",
  prize: "winnings",
  deposit: "deposits",
  security: "securityNotices"
} as const;

export function allowsNotification(prefs: NotificationPrefs, category: NotificationCategory): boolean {
  return category === "security" || prefs[PREF_BY_CATEGORY[category]] === true;
}

export type NotificationPrefsRecord = {
  version: 1;
  wallet: string;
  prefs: NotificationPrefs;
  updatedAt: number;
  revision: number;
};

export type NotificationAction = {
  id: string;
  actionType: string;
  status: string;
  updatedAt: Date;
};

const ACTION_LABEL: Record<string, string> = {
  deposit: "deposit", withdraw: "withdrawal", create_vault: "vault creation", claim: "prize claim", select_winner: "draw"
};
const STATUS_PHRASE: Record<string, string> = {
  submitted: "was submitted", confirmed: "was confirmed", failed: "failed", reverted: "was reverted", orphaned: "was marked orphaned"
};

// These notices describe the persisted action outcome, not an invented amount,
// recipient, or round. There is no additional email or push delivery channel.
export function noticeForAction(action: NotificationAction) {
  let category: NotificationCategory = "action";
  const label = ACTION_LABEL[action.actionType] || action.actionType.replaceAll("_", " ");
  let title = `${label.charAt(0).toUpperCase()}${label.slice(1)} ${action.status}`;
  if (action.status === "confirmed") {
    if (action.actionType === "deposit") {
      category = "deposit";
      title = "Deposit confirmed";
    } else if (action.actionType === "claim") {
      category = "prize";
      title = "Prize claim confirmed";
    } else if (action.actionType === "select_winner") {
      category = "round";
      title = "Draw action confirmed";
    }
  }
  return {
    id: `${action.id}:${action.status}`,
    actionId: action.id,
    category,
    type: category,
    title,
    message: `Your ${label} ${STATUS_PHRASE[action.status] || `has status ${action.status}`}.`,
    date: action.updatedAt.toISOString(),
    status: "unread"
  };
}

export class NotificationPreferencesService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly encryption: PrivacyEncryptionService
  ) {}

  async get(wallet: string): Promise<NotificationPrefsRecord> {
    // Preserve the canonical Stellar address used by privacy export/deletion.
    // Only the encryption service's internal key derivation folds case.
    const normalizedWallet = wallet.trim();
    const row = await this.prisma.userNotificationPref.findUnique({
      where: { walletAddress_category: { walletAddress: normalizedWallet, category: CATEGORY } }
    });
    if (!row) {
      return { version: 1, wallet, prefs: { ...DEFAULT_NOTIFICATION_PREFS }, updatedAt: 0, revision: 0 };
    }
    let decoded: unknown;
    try {
      decoded = this.encryption.decrypt(normalizedWallet, row.encryptedPref as unknown as EncryptedPayload);
    } catch {
      throw AppError.conflict(ERROR_CODES.CONFLICT, "stored preferences could not be read; they were left unchanged");
    }
    const parsed = storedPrefsSchema.safeParse(decoded);
    if (!parsed.success) {
      throw AppError.conflict(ERROR_CODES.CONFLICT, "stored preferences require a compatible client; they were left unchanged");
    }
    return { version: 1, wallet, prefs: parsed.data.prefs, updatedAt: row.updatedAt.getTime(), revision: row.revision };
  }

  async put(wallet: string, value: NotificationPrefs, expectedRevision: number): Promise<NotificationPrefsRecord> {
    const prefs = notificationPrefsSchema.parse(value);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= 2147483647) {
      throw AppError.validation("expectedRevision must be a non-negative revision number");
    }
    const normalizedWallet = wallet.trim();
    const encryptedPref = this.encryption.encrypt(normalizedWallet, { version: 1, prefs });
    const updatedAt = new Date();
    const revision = expectedRevision + 1;
    const data = {
      encryptedPref: encryptedPref as unknown as Prisma.InputJsonValue,
      keyVersion: this.encryption.getCurrentKeyVersion(),
      revision,
      updatedAt
    };
    if (expectedRevision === 0) {
      try {
        await this.prisma.userNotificationPref.create({ data: { walletAddress: normalizedWallet, category: CATEGORY, ...data } });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          throw this.staleSave();
        }
        throw error;
      }
    } else {
      // A newer/corrupt payload must not be downgraded by a stale client even
      // when it happens to know the row revision. The update remains atomic.
      const current = await this.get(wallet);
      if (current.revision !== expectedRevision) throw this.staleSave();
      const result = await this.prisma.userNotificationPref.updateMany({
        where: { walletAddress: normalizedWallet, category: CATEGORY, revision: expectedRevision },
        data
      });
      if (result.count !== 1) throw this.staleSave();
    }
    return { version: 1, wallet, prefs, updatedAt: updatedAt.getTime(), revision };
  }

  async history(wallet: string, limit = 100) {
    const { prefs } = await this.get(wallet);
    // Apply delivery preferences before the limit so opted-out actions cannot
    // hide an older notice that the wallet has chosen to receive.
    const categories: Prisma.ActionLedgerWhereInput[] = [];
    if (prefs.actionStatus) {
      categories.push({
        OR: [
          { status: { not: "confirmed" } },
          { actionType: { notIn: ["deposit", "claim", "select_winner"] } }
        ]
      });
    }
    for (const [actionType, preference] of [
      ["deposit", "deposits"], ["claim", "winnings"], ["select_winner", "roundUpdates"]
    ] as const) {
      if (prefs[preference]) categories.push({ actionType, status: "confirmed" });
    }
    if (categories.length === 0) return [];
    const rows = await this.prisma.actionLedger.findMany({
      where: { walletAddress: wallet, status: { not: "pending" }, OR: categories },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: limit,
      select: { id: true, actionType: true, status: true, updatedAt: true }
    });
    // Preference enforcement is at the actual in-app delivery boundary.
    return rows.map(noticeForAction).filter(notice => allowsNotification(prefs, notice.category));
  }

  private staleSave() {
    return AppError.conflict(ERROR_CODES.CONFLICT, "preferences changed on another device; reload before saving");
  }
}
