import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import { PrivacyEncryptionService } from "../src/services/privacy/privacyEncryptionService.js";
import { PrivacyAuditService } from "../src/services/privacy/privacyAuditService.js";
import { PrivacyExportService } from "../src/services/privacy/privacyExportService.js";
import { PrivacyDeletionService } from "../src/services/privacy/privacyDeletionService.js";
import { DATA_PRIVACY_INVENTORY, requiresEncryption } from "../src/services/privacy/fieldInventory.js";

describe("Data Privacy, Encryption, Retention Export & Verifiable Deletion (#76)", () => {
  let db: TestDb;
  let app: FastifyInstance;
  let encryptionSvc: PrivacyEncryptionService;
  let auditSvc: PrivacyAuditService;
  let exportSvc: PrivacyExportService;
  let deletionSvc: PrivacyDeletionService;

  const testWalletUserA = "GUSERA11111111111111111111111111111111111111111111111111";
  const testWalletUserB = "GUSERB22222222222222222222222222222222222222222222222222";
  const internalSecret = "test-internal-secret-12345";

  beforeAll(async () => {
    db = await startTestDb();
    encryptionSvc = new PrivacyEncryptionService("test_privacy_master_secret_key_32bytes!!");
    auditSvc = new PrivacyAuditService(db.prisma);
    exportSvc = new PrivacyExportService(db.prisma, encryptionSvc, auditSvc);
    deletionSvc = new PrivacyDeletionService(db.prisma, undefined, auditSvc, 7);

    app = buildApp({
      prisma: db.prisma,
      internalSecret,
      privacyMasterKey: "test_privacy_master_secret_key_32bytes!!",
    });
  });

  afterAll(async () => {
    await app.close();
    await db.stop();
  });

  beforeEach(async () => {
    await resetDb(db.prisma);
    // Extra cleanup for privacy tables
    await db.prisma.userNotificationPref.deleteMany({});
    await db.prisma.userSupportEvidence.deleteMany({});
    await db.prisma.userActivityLog.deleteMany({});
    await db.prisma.legalHold.deleteMany({});
    await db.prisma.deletionManifest.deleteMany({});
    await db.prisma.backupExpiryManifest.deleteMany({});
    await db.prisma.privacyAuditLog.deleteMany({});
  });

  describe("1. Personal Field Inventory & Classification", () => {
    it("classifies sensitive fields with purpose, sensitivity, retention and encryption flags", () => {
      expect(DATA_PRIVACY_INVENTORY["ActionLedger.actionPayload"].sensitivity).toBe("SENSITIVE");
      expect(DATA_PRIVACY_INVENTORY["UserActivityLog.encryptedIp"].sensitivity).toBe("RESTRICTED_PII");
      expect(requiresEncryption("UserNotificationPref", "encryptedPref")).toBe(true);
      expect(requiresEncryption("UserQuest", "metadata")).toBe(false);
    });
  });

  describe("2. Envelope Encryption & Key Rotation", () => {
    it("encrypts high-risk fields with per-user DEKs and prevents plaintext DB exposure", () => {
      const payloadData = { secretNote: "User Private Secret", ip: "192.168.1.10" };
      const encrypted = encryptionSvc.encrypt(testWalletUserA, payloadData);

      expect(encrypted.v).toBe(1);
      expect(encrypted.alg).toBe("aes-256-gcm");
      expect(encrypted.ciphertext).not.toContain("User Private Secret");
      expect(encrypted.ciphertext).not.toContain("192.168.1.10");

      const decrypted = encryptionSvc.decrypt(testWalletUserA, encrypted);
      expect(decrypted).toEqual(payloadData);
    });

    it("derives different DEKs per user so user B cannot decrypt user A's payload", () => {
      const payloadData = { confidential: "Confidential Data" };
      const encryptedA = encryptionSvc.encrypt(testWalletUserA, payloadData);

      expect(() => encryptionSvc.decrypt(testWalletUserB, encryptedA)).toThrow();
    });

    it("supports zero-downtime key rotation via re-encryption", () => {
      const data = { token: "super_secret_token" };
      const encryptedV1 = encryptionSvc.encrypt(testWalletUserA, data, 1);

      const reencryptedV2 = encryptionSvc.reencrypt(testWalletUserA, encryptedV1, 2);
      expect(reencryptedV2.v).toBe(2);

      const decryptedV2 = encryptionSvc.decrypt(testWalletUserA, reencryptedV2);
      expect(decryptedV2).toEqual(data);
    });
  });

  describe("3. Authenticated Retention-Aware Export & Provenance", () => {
    it("exports all in-scope user data with provenance, checksum, and cross-user isolation", async () => {
      // Seed data for User A
      await db.prisma.actionLedger.create({
        data: {
          idempotencyKey: "key-a-1",
          walletAddress: testWalletUserA,
          actionType: "deposit",
          actionPayload: encryptionSvc.encrypt(testWalletUserA, { note: "User A Action" }) as any,
          status: "confirmed",
        },
      });

      await db.prisma.userQuest.create({
        data: {
          walletAddress: testWalletUserA,
          questId: "quest-1",
          target: 100,
          progress: 50,
        },
      });

      // Seed data for User B
      await db.prisma.userQuest.create({
        data: {
          walletAddress: testWalletUserB,
          questId: "quest-b",
          target: 200,
          progress: 100,
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/privacy/export?walletAddress=${testWalletUserA}`,
      });

      expect(res.statusCode).toBe(200);
      const bundle = res.json();

      expect(bundle.provenance.walletAddress).toBe(testWalletUserA);
      expect(bundle.provenance.recordCounts.actionLedger).toBe(1);
      expect(bundle.provenance.recordCounts.userQuests).toBe(1);
      expect(bundle.provenance.checksum).toBeDefined();

      // Verify User B's quest is isolated and not returned
      const questIds = bundle.data.userQuests.map((q: any) => q.questId);
      expect(questIds).toContain("quest-1");
      expect(questIds).not.toContain("quest-b");
    });

    it("redacts third-party wallets and internal secrets in exported payloads", async () => {
      const payloadWithForeignData = {
        internal_secret: "secret_123",
        otherUser: testWalletUserB,
        details: "regular user detail",
      };

      await db.prisma.actionLedger.create({
        data: {
          idempotencyKey: "key-redact-1",
          walletAddress: testWalletUserA,
          actionType: "withdraw",
          actionPayload: encryptionSvc.encrypt(testWalletUserA, payloadWithForeignData) as any,
          status: "confirmed",
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/privacy/export?walletAddress=${testWalletUserA}`,
      });

      const bundle = res.json();
      const exportedPayload = bundle.data.actionLedger[0].actionPayload;

      expect(exportedPayload.internal_secret).toBe("[REDACTED_INTERNAL]");
      expect(exportedPayload.otherUser).toBe("[REDACTED_THIRD_PARTY_WALLET]");
      expect(exportedPayload.details).toBe("regular user detail");
    });
  });

  describe("4. Verifiable Deletion, Accounting Preservation & Manifests", () => {
    it("anonymizes ledger identities while deleting personal data and issuing completion manifest", async () => {
      // Seed user data
      await db.prisma.actionLedger.create({
        data: {
          idempotencyKey: "key-del-1",
          walletAddress: testWalletUserA,
          actionType: "deposit",
          actionPayload: { sensitive: "data" },
          status: "confirmed",
        },
      });

      await db.prisma.userQuest.create({
        data: {
          walletAddress: testWalletUserA,
          questId: "quest-del-1",
          target: 10,
        },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/privacy/delete",
        headers: { "content-type": "application/json" },
        payload: { walletAddress: testWalletUserA },
      });

      expect(res.statusCode).toBe(200);
      const result = res.json();

      expect(result.status).toBe("completed");
      expect(result.deletedCounts.actionLedgerAnonymized).toBe(1);
      expect(result.deletedCounts.userQuestsDeleted).toBe(1);
      expect(result.manifestHash).toBeDefined();

      // Verify DB State: ActionLedger anonymized, identity redacted
      const ledgerEntry = await db.prisma.actionLedger.findFirst({
        where: { idempotencyKey: "key-del-1" },
      });
      expect(ledgerEntry).not.toBeNull();
      expect(ledgerEntry?.walletAddress).toContain("[REDACTED_USER_");
      expect(ledgerEntry?.actionPayload).toBeNull();
      expect(ledgerEntry?.redactedAt).not.toBeNull();

      // Verify UserQuest deleted
      const questEntry = await db.prisma.userQuest.findFirst({
        where: { walletAddress: testWalletUserA },
      });
      expect(questEntry).toBeNull();

      // Verify DeletionManifest & BackupExpiryManifest created
      const manifest = await db.prisma.deletionManifest.findUnique({
        where: { id: result.manifestId },
      });
      expect(manifest).not.toBeNull();
      expect(manifest?.status).toBe("completed");

      const backupManifest = await db.prisma.backupExpiryManifest.findFirst({
        where: { deletionManifestId: result.manifestId },
      });
      expect(backupManifest).not.toBeNull();
    });

    it("is idempotent when deletion is triggered repeatedly", async () => {
      const firstRes = await app.inject({
        method: "POST",
        url: "/api/privacy/delete",
        headers: { "content-type": "application/json" },
        payload: { walletAddress: testWalletUserA },
      });
      expect(firstRes.statusCode).toBe(200);

      const secondRes = await app.inject({
        method: "POST",
        url: "/api/privacy/delete",
        headers: { "content-type": "application/json" },
        payload: { walletAddress: testWalletUserA },
      });
      expect(secondRes.statusCode).toBe(200);
      expect(secondRes.json().status).toBe("completed");
    });
  });

  describe("5. Legal Holds Enforcement", () => {
    it("blocks deletion when active legal hold exists and records held status", async () => {
      // Create legal hold on User A
      await app.inject({
        method: "POST",
        url: "/api/privacy/legal-holds",
        headers: {
          "content-type": "application/json",
          "x-internal-secret": internalSecret,
        },
        payload: {
          walletAddress: testWalletUserA,
          reason: "Regulatory Audit #104",
          active: true,
        },
      });

      // Seed quest for User A
      await db.prisma.userQuest.create({
        data: {
          walletAddress: testWalletUserA,
          questId: "quest-hold-1",
          target: 10,
        },
      });

      // Attempt deletion
      const delRes = await app.inject({
        method: "POST",
        url: "/api/privacy/delete",
        headers: { "content-type": "application/json" },
        payload: { walletAddress: testWalletUserA },
      });

      expect(delRes.statusCode).toBe(200);
      const result = delRes.json();

      expect(result.status).toBe("held_by_legal_hold");
      expect(result.heldCounts.recordsHeld).toBe(1);

      // Verify UserQuest was NOT deleted
      const quest = await db.prisma.userQuest.findFirst({
        where: { walletAddress: testWalletUserA },
      });
      expect(quest).not.toBeNull();
    });

    it("resumes deletion once legal hold is released", async () => {
      // Set active hold
      await app.inject({
        method: "POST",
        url: "/api/privacy/legal-holds",
        headers: {
          "content-type": "application/json",
          "x-internal-secret": internalSecret,
        },
        payload: { walletAddress: testWalletUserA, reason: "Test Hold", active: true },
      });

      await db.prisma.userQuest.create({
        data: { walletAddress: testWalletUserA, questId: "q-resume", target: 5 },
      });

      // Release hold
      await app.inject({
        method: "POST",
        url: "/api/privacy/legal-holds",
        headers: {
          "content-type": "application/json",
          "x-internal-secret": internalSecret,
        },
        payload: { walletAddress: testWalletUserA, active: false },
      });

      // Delete user data
      const delRes = await app.inject({
        method: "POST",
        url: "/api/privacy/delete",
        headers: { "content-type": "application/json" },
        payload: { walletAddress: testWalletUserA },
      });

      expect(delRes.json().status).toBe("completed");
      const quest = await db.prisma.userQuest.findFirst({
        where: { walletAddress: testWalletUserA },
      });
      expect(quest).toBeNull();
    });
  });

  describe("6. Audit Logging & Redaction", () => {
    it("logs privileged privacy operations with hashed wallet references and no stored PII", async () => {
      await auditSvc.log({
        action: "EXPORT",
        actorWallet: testWalletUserA,
        targetWallet: testWalletUserA,
        details: { ip: "10.0.0.1", user_email: "test@example.com", status: "success" },
      });

      const logs = await db.prisma.privacyAuditLog.findMany({
        where: { action: "EXPORT" },
      });

      expect(logs).toHaveLength(1);
      const log = logs[0];
      const details = log.details as any;

      expect(log.targetWalletHash).toBeDefined();
      expect(log.targetWalletHash).not.toContain(testWalletUserA);
      expect(details.ip).toBe("[REDACTED_AUDIT]");
      expect(details.user_email).toBe("[REDACTED_AUDIT]");
      expect(details.status).toBe("success");
    });
  });
});
