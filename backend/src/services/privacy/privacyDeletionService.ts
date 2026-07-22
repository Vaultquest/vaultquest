import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { CacheService } from "../cacheService.js";
import { PrivacyAuditService } from "./privacyAuditService.js";

export interface DeletionResult {
  manifestId: string;
  walletAddressHash: string;
  status: "completed" | "held_by_legal_hold" | "partial_error";
  deletedCounts: {
    actionLedgerAnonymized: number;
    userQuestsDeleted: number;
    savedPoolsDeleted: number;
    notificationPrefsDeleted: number;
    supportEvidenceDeleted: number;
    activityLogsDeleted: number;
    cacheKeysInvalidated: number;
  };
  heldCounts: {
    recordsHeld: number;
  };
  manifestHash: string;
  backupRetentionCutoff: string;
  completedAt: string;
}

export class PrivacyDeletionService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cacheSvc: CacheService | undefined,
    private readonly auditSvc: PrivacyAuditService,
    private readonly backupRetainDays = 7
  ) {}

  /**
   * Generates deterministic hash for redacted identity references in protocol ledger.
   */
  private anonymizeWalletReference(walletAddress: string): string {
    const hash = createHash("sha256")
      .update(`anonymized_identity_salt:${walletAddress.toLowerCase()}`)
      .digest("hex")
      .substring(0, 16);
    return `[REDACTED_USER_${hash}]`;
  }

  async deleteUserData(walletAddress: string, actorWallet?: string): Promise<DeletionResult> {
    const normalizedWallet = walletAddress.trim();
    const walletHash = this.auditSvc.hashWallet(normalizedWallet)!;

    await this.auditSvc.log({
      action: "DELETE_REQUESTED",
      actorWallet: actorWallet || normalizedWallet,
      targetWallet: normalizedWallet,
    });

    // 1. Check for Active Legal Hold
    const activeHold = await this.prisma.legalHold.findFirst({
      where: {
        walletAddress: normalizedWallet,
        active: true,
      },
    });

    if (activeHold) {
      // Calculate how many records are held under legal hold
      const ledgerCount = await this.prisma.actionLedger.count({
        where: { walletAddress: normalizedWallet },
      });
      const questCount = await this.prisma.userQuest.count({
        where: { walletAddress: normalizedWallet },
      });
      const poolCount = await this.prisma.savedPool.count({
        where: { walletAddress: normalizedWallet },
      });
      const heldCount = ledgerCount + questCount + poolCount;

      const manifestId = randomUUID();
      const manifestHash = createHash("sha256")
        .update(`held:${normalizedWallet}:${heldCount}:${Date.now()}`)
        .digest("hex");

      const heldCounts = { recordsHeld: heldCount };
      const deletedCounts = {
        actionLedgerAnonymized: 0,
        userQuestsDeleted: 0,
        savedPoolsDeleted: 0,
        notificationPrefsDeleted: 0,
        supportEvidenceDeleted: 0,
        activityLogsDeleted: 0,
        cacheKeysInvalidated: 0,
      };

      await this.prisma.deletionManifest.create({
        data: {
          id: manifestId,
          walletAddressHash: walletHash,
          status: "held_by_legal_hold",
          deletedCounts: deletedCounts as object,
          heldCounts: heldCounts as object,
          manifestHash,
        },
      });

      await this.auditSvc.log({
        action: "DELETE_BLOCKED_LEGAL_HOLD",
        actorWallet: actorWallet || normalizedWallet,
        targetWallet: normalizedWallet,
        details: { reason: activeHold.reason, heldCount },
      });

      const cutoffDate = new Date(Date.now() + this.backupRetainDays * 24 * 60 * 60 * 1000);

      return {
        manifestId,
        walletAddressHash: walletHash,
        status: "held_by_legal_hold",
        deletedCounts,
        heldCounts,
        manifestHash,
        backupRetentionCutoff: cutoffDate.toISOString(),
        completedAt: new Date().toISOString(),
      };
    }

    // 2. Perform Idempotent Deletion & Anonymization
    const anonymizedWallet = this.anonymizeWalletReference(normalizedWallet);

    // 2a. Anonymize Action Ledger
    const ledgerUpdate = await this.prisma.actionLedger.updateMany({
      where: { walletAddress: normalizedWallet },
      data: {
        walletAddress: anonymizedWallet,
        actionPayload: undefined,
        errorDetail: null,
        redactedAt: new Date(),
      },
    });

    // 2b. Delete User Quests
    const questDelete = await this.prisma.userQuest.deleteMany({
      where: { walletAddress: normalizedWallet },
    });

    // 2c. Delete Saved Pools
    const poolDelete = await this.prisma.savedPool.deleteMany({
      where: { walletAddress: normalizedWallet },
    });

    // 2d. Delete Notification Prefs
    const prefDelete = await this.prisma.userNotificationPref.deleteMany({
      where: { walletAddress: normalizedWallet },
    });

    // 2e. Delete Support Evidence
    const evidenceDelete = await this.prisma.userSupportEvidence.deleteMany({
      where: { walletAddress: normalizedWallet },
    });

    // 2f. Delete Activity Logs
    const logDelete = await this.prisma.userActivityLog.deleteMany({
      where: { walletAddress: normalizedWallet },
    });

    // 3. Invalidate Caches
    let cacheKeysInvalidated = 0;
    if (this.cacheSvc) {
      try {
        await this.cacheSvc.invalidate(`user:${normalizedWallet}`);
        await this.cacheSvc.invalidate(`user_quests:${normalizedWallet}`);
        await this.cacheSvc.invalidate(`saved_pools:${normalizedWallet}`);
        cacheKeysInvalidated = 3;
      } catch {
        // Cache invalidate best effort
      }
    }

    const deletedCounts = {
      actionLedgerAnonymized: ledgerUpdate.count,
      userQuestsDeleted: questDelete.count,
      savedPoolsDeleted: poolDelete.count,
      notificationPrefsDeleted: prefDelete.count,
      supportEvidenceDeleted: evidenceDelete.count,
      activityLogsDeleted: logDelete.count,
      cacheKeysInvalidated,
    };

    const manifestId = randomUUID();
    const manifestHashPayload = `${manifestId}:${walletHash}:${JSON.stringify(deletedCounts)}`;
    const manifestHash = createHash("sha256").update(manifestHashPayload).digest("hex");

    const cutoffDate = new Date(Date.now() + this.backupRetainDays * 24 * 60 * 60 * 1000);

    // 4. Save Manifest & Backup Expiry Manifest
    await this.prisma.deletionManifest.create({
      data: {
        id: manifestId,
        walletAddressHash: walletHash,
        status: "completed",
        deletedCounts: deletedCounts as object,
        heldCounts: { recordsHeld: 0 } as object,
        manifestHash,
      },
    });

    await this.prisma.backupExpiryManifest.create({
      data: {
        deletionManifestId: manifestId,
        walletAddressHash: walletHash,
        backupRetentionCutoff: cutoffDate,
      },
    });

    await this.auditSvc.log({
      action: "DELETE_COMPLETED",
      actorWallet: actorWallet || normalizedWallet,
      targetWallet: normalizedWallet,
      details: { manifestId, manifestHash, deletedCounts },
    });

    return {
      manifestId,
      walletAddressHash: walletHash,
      status: "completed",
      deletedCounts,
      heldCounts: { recordsHeld: 0 },
      manifestHash,
      backupRetentionCutoff: cutoffDate.toISOString(),
      completedAt: new Date().toISOString(),
    };
  }

  async getManifest(manifestId: string) {
    return this.prisma.deletionManifest.findUnique({
      where: { id: manifestId },
    });
  }
}
