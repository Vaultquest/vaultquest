import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID, sign } from "node:crypto";
import { type Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { buildWalletChallenge } from "../src/middleware/wallet-auth.js";
import { verifySignature } from "../src/utils/stellarKey.js";
import { PrivacyEncryptionService } from "../src/services/privacy/privacyEncryptionService.js";
import { allowsNotification, DEFAULT_NOTIFICATION_PREFS, NotificationPreferencesService } from "../src/services/notificationPreferences.js";
import { createTestWallet, type TestWallet } from "./helpers/wallet.js";
import { injectWithCsrf } from "./helpers/csrf.js";
import { startTestDb, type TestDb } from "./helpers/db.js";

const MASTER_KEY = "notification-integration-test-key";
const category = "notification_preferences";
let timestamp = Date.now();

function signedHeaders(wallet: TestWallet, at = timestamp++) {
  const message = buildWalletChallenge(wallet.address, at);
  const digest = createHash("sha256").update("Stellar Signed Message:\n").update(message, "utf8").digest();
  return {
    "x-wallet-address": wallet.address,
    "x-wallet-timestamp": String(at),
    "x-wallet-signature": sign(null, digest, wallet.privateKey).toString("base64")
  };
}

describe("Stellar notification signatures", () => {
  it("verifies the published SEP-53 UTF-8/SHA-256 test vector", () => {
    // https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0053.md
    expect(verifySignature(
      "GBXFXNDLV4LSWA4VB7YIL5GBD7BVNR22SGBTDKMO2SBZZHDXSKZYCP7L",
      "Hello, World!",
      "fO5dbYhXUhBMhe6kId/cuVq/AfEnHRHEvsP8vXh03M1uLpi5e46yO2Q8rEBzu3feXQewcQE5GArp88u6ePK6BA=="
    )).toBe(true);
  });

  it("keeps raw Ed25519 challenge compatibility and rejects altered messages", () => {
    const wallet = createTestWallet();
    const message = buildWalletChallenge(wallet.address, timestamp++);
    const signature = wallet.signMessage(message);
    expect(verifySignature(wallet.address, message, signature)).toBe(true);
    expect(verifySignature(wallet.address, `${message}changed`, signature)).toBe(false);
    expect(verifySignature(createTestWallet().address, message, signature)).toBe(false);
  });

  it("requires a canonical base64 representation of exactly 64 signature bytes", () => {
    const wallet = createTestWallet();
    const signature = wallet.signMessage("test");
    for (const malformed of [signature.slice(0, -1), `${signature}\n`, `${signature}ignored`, Buffer.alloc(65).toString("base64"), "!"] ) {
      expect(verifySignature(wallet.address, "test", malformed)).toBe(false);
    }
  });
});

describe("notification preferences through Prisma and the actual app", () => {
  let db: TestDb;
  let app: FastifyInstance;
  let otherClient: PrismaClient;
  let service: NotificationPreferencesService;
  let otherService: NotificationPreferencesService;
  const encryption = new PrivacyEncryptionService(MASTER_KEY);
  const wallets: string[] = [];
  let ip = 1;

  function wallet() {
    const value = createTestWallet();
    wallets.push(value.address);
    return value;
  }

  function get(path: string, headers: Record<string, string> = {}) {
    return app.inject({ method: "GET", url: path, headers, remoteAddress: `192.0.2.${ip++}` });
  }

  function put(owner: TestWallet, prefs: unknown, expectedRevision: number, headers: Record<string, string> = signedHeaders(owner)) {
    return injectWithCsrf(app, "PUT", "/notification-prefs", {
      wallet_address: owner.address, version: 1, prefs, expectedRevision
    }, headers);
  }

  beforeAll(async () => {
    // An explicitly supplied test database must already have its migrations.
    // All inserted data uses fresh synthetic wallets and is removed below.
    const databaseUrl = process.env.VQ_NOTIFICATION_TEST_DATABASE_URL;
    if (databaseUrl) {
      const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      db = { prisma, databaseUrl, stop: () => prisma.$disconnect() };
    } else {
      db = await startTestDb();
    }
    otherClient = new PrismaClient({ datasources: { db: { url: db.databaseUrl } } });
    service = new NotificationPreferencesService(db.prisma, encryption);
    otherService = new NotificationPreferencesService(otherClient, new PrivacyEncryptionService(MASTER_KEY));
    app = buildApp({ prisma: db.prisma, apiKey: "notification-test-service-key-1234567890", internalSecret: "notification-test-internal-secret", privacyMasterKey: MASTER_KEY, environment: "test" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.prisma.actionLedger.deleteMany({ where: { walletAddress: { in: wallets } } });
      await db.prisma.userNotificationPref.deleteMany({ where: { walletAddress: { in: wallets } } });
    }
    await otherClient?.$disconnect();
    await db?.stop();
  });

  it("loads versioned defaults without creating an unsolicited record", async () => {
    const owner = wallet();
    const response = await get(`/notification-prefs?wallet=${owner.address}`, signedHeaders(owner));
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.json().data).toEqual({ version: 1, wallet: owner.address, prefs: DEFAULT_NOTIFICATION_PREFS, updatedAt: 0, revision: 0 });
    expect(await db.prisma.userNotificationPref.count({ where: { walletAddress: owner.address } })).toBe(0);
  });

  it("requires wallet proof without a service credential, and retains the existing CSRF check", async () => {
    const owner = wallet();
    expect((await get(`/notification-prefs?wallet=${owner.address}`)).statusCode).toBe(401);
    expect((await put(owner, DEFAULT_NOTIFICATION_PREFS, 0, {})).statusCode).toBe(401);
    const noCsrf = await app.inject({ method: "PUT", url: "/notification-prefs", headers: signedHeaders(owner), payload: { wallet_address: owner.address, prefs: DEFAULT_NOTIFICATION_PREFS, expectedRevision: 0 } });
    expect(noCsrf.statusCode).toBe(403);
  });

  it("rejects another wallet's GET, PUT, and notification history", async () => {
    const owner = wallet();
    const intruder = wallet();
    expect((await get(`/notification-prefs?wallet=${owner.address}`, signedHeaders(intruder))).statusCode).toBe(403);
    expect((await put(owner, DEFAULT_NOTIFICATION_PREFS, 0, signedHeaders(intruder))).statusCode).toBe(403);
    expect((await get(`/notifications?wallet=${owner.address}`, signedHeaders(intruder))).statusCode).toBe(403);
    expect((await service.get(owner.address)).revision).toBe(0);
  });

  it("rejects expired, mismatched, and replayed proofs", async () => {
    const owner = wallet();
    const path = `/notification-prefs?wallet=${owner.address}`;
    expect((await get(path, signedHeaders(owner, Date.now() - 600_000))).statusCode).toBe(401);
    expect((await get(path, { ...signedHeaders(wallet()), "x-wallet-address": owner.address })).statusCode).toBe(401);
    const proof = signedHeaders(owner);
    expect((await get(path, proof)).statusCode).toBe(200);
    expect((await get(path, proof)).statusCode).toBe(401);
  });

  it("persists a signed save and reloads it through an independent Prisma client", async () => {
    const owner = wallet();
    const prefs = { ...DEFAULT_NOTIFICATION_PREFS, deposits: true, roundUpdates: false };
    const response = await put(owner, prefs, 0);
    expect(response.statusCode).toBe(200);
    const saved = response.json().data;
    expect(saved).toMatchObject({ version: 1, wallet: owner.address, prefs, revision: 1 });
    expect(saved.updatedAt).toBeGreaterThan(0);
    expect(typeof saved.updatedAt).toBe("number");
    expect(await otherService.get(owner.address)).toEqual(saved);
    expect((await get(`/notification-prefs?wallet=${owner.address}`, signedHeaders(owner))).json().data).toEqual(saved);
  });

  it("returns 409 for a stale device and leaves the acknowledged save intact", async () => {
    const owner = wallet();
    expect((await put(owner, DEFAULT_NOTIFICATION_PREFS, 0)).statusCode).toBe(200);
    const prefs = { ...DEFAULT_NOTIFICATION_PREFS, winnings: false };
    const saved = await put(owner, prefs, 1);
    expect(saved.statusCode).toBe(200);
    const stale = await put(owner, { ...DEFAULT_NOTIFICATION_PREFS, deposits: true }, 1);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("CONFLICT");
    expect(await otherService.get(owner.address)).toEqual(saved.json().data);
  });

  it("uses the canonical wallet key required by existing exact-wallet privacy queries", async () => {
    const owner = wallet();
    await service.put(owner.address, DEFAULT_NOTIFICATION_PREFS, 0);
    // The existing privacy export/delete paths query the canonical address,
    // not the encryption service's case-folded derivation key.
    const rows = await db.prisma.userNotificationPref.findMany({ where: { walletAddress: owner.address.trim() } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.walletAddress).toBe(owner.address);
    const removed = await db.prisma.userNotificationPref.deleteMany({ where: { walletAddress: owner.address.trim() } });
    expect(removed.count).toBe(1);
    expect((await service.get(owner.address)).revision).toBe(0);
  });

  it("allows only one simultaneous first save for a wallet", async () => {
    const owner = wallet();
    const results = await Promise.allSettled([
      service.put(owner.address, DEFAULT_NOTIFICATION_PREFS, 0),
      otherService.put(owner.address, { ...DEFAULT_NOTIFICATION_PREFS, deposits: true }, 0)
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(failure.reason.statusCode).toBe(409);
    const success = results.find(result => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof service.put>>>;
    expect(await service.get(owner.address)).toEqual(success.value);
  });

  it("atomically rejects one of two concurrent saves of the same loaded revision", async () => {
    const owner = wallet();
    await service.put(owner.address, DEFAULT_NOTIFICATION_PREFS, 0);
    const results = await Promise.allSettled([
      service.put(owner.address, { ...DEFAULT_NOTIFICATION_PREFS, roundUpdates: false }, 1),
      otherService.put(owner.address, { ...DEFAULT_NOTIFICATION_PREFS, deposits: true }, 1)
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 });
    expect((await service.get(owner.address)).revision).toBe(2);
  });

  it("rejects malformed preferences and attempts to disable mandatory security notices", async () => {
    const owner = wallet();
    for (const prefs of [{ ...DEFAULT_NOTIFICATION_PREFS, securityNotices: false }, { ...DEFAULT_NOTIFICATION_PREFS, deposits: "yes" }, { ...DEFAULT_NOTIFICATION_PREFS, newCategory: true }]) {
      expect((await put(owner, prefs, 0)).statusCode).toBe(400);
    }
    expect((await service.get(owner.address)).revision).toBe(0);
    expect(allowsNotification({ ...DEFAULT_NOTIFICATION_PREFS, actionStatus: false, roundUpdates: false, winnings: false, deposits: false }, "security")).toBe(true);
  });

  it("stores ciphertext under the existing privacy model, and refuses unreadable or newer formats", async () => {
    const owner = wallet();
    await service.put(owner.address, DEFAULT_NOTIFICATION_PREFS, 0);
    const where = { walletAddress_category: { walletAddress: owner.address, category } };
    const row = await db.prisma.userNotificationPref.findUniqueOrThrow({ where });
    expect(JSON.stringify(row.encryptedPref)).not.toContain("roundUpdates");
    const wrongKey = new NotificationPreferencesService(db.prisma, new PrivacyEncryptionService("a different test key"));
    await expect(wrongKey.get(owner.address)).rejects.toMatchObject({ statusCode: 409 });
    const future = encryption.encrypt(owner.address, { version: 2, prefs: DEFAULT_NOTIFICATION_PREFS });
    await db.prisma.userNotificationPref.update({ where, data: { encryptedPref: future as unknown as Prisma.InputJsonValue } });
    expect((await get(`/notification-prefs?wallet=${owner.address}`, signedHeaders(owner))).statusCode).toBe(409);
    expect((await put(owner, DEFAULT_NOTIFICATION_PREFS, 1)).statusCode).toBe(409);
    expect((await db.prisma.userNotificationPref.findUniqueOrThrow({ where })).encryptedPref).toEqual(future);
  });

  it("counts only enabled notices toward the history limit", async () => {
    const owner = wallet();
    const other = wallet();
    const base = Date.parse("2026-10-04T00:00:00Z");
    function action(
      actionType: Prisma.ActionLedgerCreateManyInput["actionType"],
      status: Prisma.ActionLedgerCreateManyInput["status"],
      offset: number,
      walletAddress = owner.address
    ): Prisma.ActionLedgerCreateManyInput {
      return { id: randomUUID(), idempotencyKey: randomUUID(), walletAddress, actionType, status, updatedAt: new Date(base + offset) };
    }
    const prize = action("claim", "confirmed", 1);
    const withdrawal = action("withdraw", "confirmed", 0);
    const deposits = Array.from({ length: 100 }, (_, index) => action("deposit", "confirmed", index + 2));
    await db.prisma.actionLedger.createMany({ data: [
      prize, withdrawal, ...deposits,
      action("withdraw", "confirmed", 102, other.address),
      action("claim", "pending", 103)
    ] });

    const path = `/notifications?wallet=${owner.address}`;
    const response = await get(path, signedHeaders(owner));
    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((notice: { actionId: string }) => notice.actionId)).toEqual([prize.id, withdrawal.id]);
    const first = await get(`${path}&limit=1`, signedHeaders(owner));
    expect(first.statusCode).toBe(200);
    expect(first.json().data.map((notice: { actionId: string }) => notice.actionId)).toEqual([prize.id]);

    const onlyDeposits = { ...DEFAULT_NOTIFICATION_PREFS, actionStatus: false, roundUpdates: false, winnings: false, deposits: true };
    expect((await put(owner, onlyDeposits, 0)).statusCode).toBe(200);
    const enabled = await get(`${path}&limit=2`, signedHeaders(owner));
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().data.map((notice: { actionId: string }) => notice.actionId)).toEqual(deposits.slice(-2).reverse().map(deposit => deposit.id));
  });

  it("filters actual persisted action, round, prize, and deposit notices before delivery", async () => {
    const owner = wallet();
    const other = wallet();
    const actions = [
      { walletAddress: owner.address, actionType: "withdraw" as const, status: "confirmed" as const },
      { walletAddress: owner.address, actionType: "select_winner" as const, status: "confirmed" as const },
      { walletAddress: owner.address, actionType: "claim" as const, status: "confirmed" as const },
      { walletAddress: owner.address, actionType: "deposit" as const, status: "confirmed" as const },
      { walletAddress: owner.address, actionType: "deposit" as const, status: "failed" as const },
      { walletAddress: owner.address, actionType: "claim" as const, status: "pending" as const },
      { walletAddress: other.address, actionType: "withdraw" as const, status: "confirmed" as const }
    ];
    await db.prisma.actionLedger.createMany({ data: actions.map(action => ({ ...action, idempotencyKey: randomUUID() })) });
    const path = `/notifications?wallet=${owner.address}`;
    const defaults = await get(path, signedHeaders(owner));
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json().data.map((notice: { category: string }) => notice.category).sort()).toEqual(["action", "action", "prize", "round"]);
    const onlyDeposits = { ...DEFAULT_NOTIFICATION_PREFS, actionStatus: false, roundUpdates: false, winnings: false, deposits: true };
    expect((await put(owner, onlyDeposits, 0)).statusCode).toBe(200);
    const delivered = (await get(path, signedHeaders(owner))).json().data;
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ category: "deposit", title: "Deposit confirmed" });
    expect((await put(owner, { ...onlyDeposits, deposits: false }, 1)).statusCode).toBe(200);
    expect((await get(path, signedHeaders(owner))).json().data).toEqual([]);
    expect((await get(`/notifications?wallet=${owner.address}&limit=101`, signedHeaders(owner))).statusCode).toBe(400);
  });
});
