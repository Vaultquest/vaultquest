import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { PrivacyEncryptionService, type EncryptedPayload } from "./privacyEncryptionService.js";
import { PrivacyAuditService } from "./privacyAuditService.js";

export interface DataExportBundle {
  provenance: {
    exportId: string;
    walletAddress: string;
    exportedAt: string;
    schemaVersion: string;
    recordCounts: {
      actionLedger: number;
      userQuests: number;
      savedPools: number;
      notificationPrefs: number;
      supportEvidence: number;
      activityLogs: number;
    };
    checksum: string;
  };
  data: {
    actionLedger: unknown[];
    userQuests: unknown[];
    savedPools: unknown[];
    notificationPrefs: unknown[];
    supportEvidence: unknown[];
    activityLogs: unknown[];
  };
}

export class PrivacyExportService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly encryptionSvc: PrivacyEncryptionService,
    private readonly auditSvc: PrivacyAuditService
  ) {}

  /**
   * Sanitizes third-party data or internal platform secrets from exported payloads.
   */
  private redactThirdPartyData(obj: unknown, requestingWallet: string): unknown {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj !== "object") return obj;

    if (Array.isArray(obj)) {
      return obj.map((item) => this.redactThirdPartyData(item, requestingWallet));
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      if (lowerKey.includes("internal_secret") || lowerKey.includes("private_key")) {
        result[key] = "[REDACTED_INTERNAL]";
      } else if (
        typeof value === "string" &&
        value.startsWith("G") &&
        value.length === 56 &&
        value.toLowerCase() !== requestingWallet.toLowerCase()
      ) {
        // Redact foreign Stellar public keys in payload
        result[key] = "[REDACTED_THIRD_PARTY_WALLET]";
      } else if (typeof value === "object" && value !== null) {
        result[key] = this.redactThirdPartyData(value, requestingWallet);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  async exportUserData(walletAddress: string): Promise<DataExportBundle> {
    const normalizedWallet = walletAddress.trim();

    // 1. Fetch Action Ledger
    const ledgerRecords = await this.prisma.actionLedger.findMany({
      where: { walletAddress: normalizedWallet },
      orderBy: { createdAt: "desc" },
    });

    const decryptedLedger = ledgerRecords.map((rec) => {
      let payload = rec.actionPayload;
      if (payload && typeof payload === "object" && "ciphertext" in payload) {
        try {
          payload = this.encryptionSvc.decrypt(normalizedWallet, payload as EncryptedPayload) as any;
        } catch {
          // keep as is if decryption fails
        }
      }
      return {
        id: rec.id,
        idempotencyKey: rec.idempotencyKey,
        actionType: rec.actionType,
        actionPayload: this.redactThirdPartyData(payload, normalizedWallet),
        status: rec.status,
        txHash: rec.txHash,
        sorobanEventId: rec.sorobanEventId,
        createdAt: rec.createdAt,
        submittedAt: rec.submittedAt,
        confirmedAt: rec.confirmedAt,
      };
    });

    // 2. Fetch User Quests
    const questRecords = await this.prisma.userQuest.findMany({
      where: { walletAddress: normalizedWallet },
    });

    // 3. Fetch Saved Pools
    const poolRecords = await this.prisma.savedPool.findMany({
      where: { walletAddress: normalizedWallet },
    });

    // 4. Fetch Notification Prefs
    const prefRecords = await this.prisma.userNotificationPref.findMany({
      where: { walletAddress: normalizedWallet },
    });
    const decryptedPrefs = prefRecords.map((p) => ({
      category: p.category,
      preference: this.encryptionSvc.decrypt(normalizedWallet, p.encryptedPref as EncryptedPayload),
      updatedAt: p.updatedAt,
    }));

    // 5. Fetch Support Evidence
    const evidenceRecords = await this.prisma.userSupportEvidence.findMany({
      where: { walletAddress: normalizedWallet },
    });
    const decryptedEvidence = evidenceRecords.map((e) => ({
      ticketId: e.ticketId,
      evidence: this.encryptionSvc.decrypt(normalizedWallet, e.encryptedData as EncryptedPayload),
      createdAt: e.createdAt,
    }));

    // 6. Fetch Activity Logs
    const logRecords = await this.prisma.userActivityLog.findMany({
      where: { walletAddress: normalizedWallet },
    });
    const decryptedLogs = logRecords.map((l) => ({
      activityType: l.activityType,
      ipAddress: l.encryptedIp
        ? this.encryptionSvc.decrypt(normalizedWallet, l.encryptedIp as EncryptedPayload)
        : null,
      metadata: l.encryptedMeta
        ? this.encryptionSvc.decrypt(normalizedWallet, l.encryptedMeta as EncryptedPayload)
        : null,
      createdAt: l.createdAt,
    }));

    const exportData = {
      actionLedger: decryptedLedger,
      userQuests: questRecords,
      savedPools: poolRecords,
      notificationPrefs: decryptedPrefs,
      supportEvidence: decryptedEvidence,
      activityLogs: decryptedLogs,
    };

    const dataJson = JSON.stringify(exportData);
    const checksum = createHash("sha256").update(dataJson).digest("hex");

    const exportBundle: DataExportBundle = {
      provenance: {
        exportId: randomUUID(),
        walletAddress: normalizedWallet,
        exportedAt: new Date().toISOString(),
        schemaVersion: "1.0",
        recordCounts: {
          actionLedger: decryptedLedger.length,
          userQuests: questRecords.length,
          savedPools: poolRecords.length,
          notificationPrefs: decryptedPrefs.length,
          supportEvidence: decryptedEvidence.length,
          activityLogs: decryptedLogs.length,
        },
        checksum,
      },
      data: exportData,
    };

    await this.auditSvc.log({
      action: "EXPORT",
      actorWallet: normalizedWallet,
      targetWallet: normalizedWallet,
      details: {
        exportId: exportBundle.provenance.exportId,
        recordCounts: exportBundle.provenance.recordCounts,
      },
    });

    return exportBundle;
  }
}
