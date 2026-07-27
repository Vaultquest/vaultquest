import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createTestWallet } from "./helpers/wallet.js";
import { buildExportChallenge } from "../src/middleware/export-auth.js";

/**
 * Authorization for GET /actions/export (issue #10).
 *
 * The vulnerability being closed: `?wallet=` both selected the data and stood
 * in for authorization, so any caller could name any wallet.
 */

const INTERNAL_SECRET = "test-internal-secret-123456";
const API_KEY = "k".repeat(32);

/**
 * Returns rows only for the wallet Prisma is actually queried with, so a test
 * that leaks another wallet's data fails on content, not just status code.
 */
function getMockPrisma(rowsByWallet: Record<string, unknown[]> = {}) {
  return {
    actionLedger: {
      findMany: vi.fn().mockImplementation(async (args: { where?: { walletAddress?: string } }) => {
        const wallet = args?.where?.walletAddress ?? "";
        return (rowsByWallet[wallet] ?? []) as unknown[];
      }),
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
      groupBy: vi.fn().mockResolvedValue([])
    },
    savedPool: { findMany: vi.fn().mockResolvedValue([]) },
    indexerCheckpoint: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ id: "singleton" })
    },
    vaultSettlement: { findMany: vi.fn().mockResolvedValue([]) },
    userQuest: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn().mockImplementation(async (args: unknown) => {
      if (Array.isArray(args)) return [0, []];
      return (args as (tx: unknown) => unknown)(null);
    })
  } as unknown as PrismaClient & { actionLedger: { findMany: ReturnType<typeof vi.fn> } };
}

function actionRow(walletAddress: string, overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    idempotencyKey: randomUUID(),
    walletAddress,
    actionType: "deposit",
    actionPayload: { vault_id: "v_usdc", amount: "100", token: "USDC" },
    status: "confirmed",
    txHash: "tx_abc123",
    sorobanEventId: null,
    correlationId: null,
    errorCode: null,
    errorDetail: null,
    retryCount: 0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    submittedAt: new Date("2026-01-01T00:00:00Z"),
    confirmedAt: new Date("2026-01-01T00:00:00Z"),
    redactedAt: null,
    ...overrides
  };
}

let ipCounter = 1;
function get(app: FastifyInstance, url: string, headers: Record<string, string> = {}) {
  // Unique IP per request keeps the rate limiter from bleeding across tests.
  return app.inject({ method: "GET", url, remoteAddress: `192.168.200.${ipCounter++ % 254}`, headers });
}

describe("GET /actions/export authorization (#10)", () => {
  describe("the vulnerability: one wallet exporting another's history", () => {
    it("rejects wallet A asking for wallet B's export", async () => {
      const walletA = createTestWallet();
      const walletB = createTestWallet();
      const prisma = getMockPrisma({ [walletB.address]: [actionRow(walletB.address)] });
      const app = buildApp({ prisma, internalSecret: INTERNAL_SECRET });

      // A authenticates correctly as itself, then names B in the query string.
      const res = await get(app, `/actions/export?wallet=${walletB.address}`, walletA.authHeaders());

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("FORBIDDEN");
      // The decisive assertion: B's history was never even queried.
      expect(prisma.actionLedger.findMany).not.toHaveBeenCalled();
      await app.close();
    });

    it("rejects wallet A replaying a signature onto wallet B's address", async () => {
      const walletA = createTestWallet();
      const walletB = createTestWallet();
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });
      const timestamp = Date.now();

      // Presenting B's address with A's signature: the challenge binds the
      // address, so the signature does not verify against B's key.
      const res = await get(app, `/actions/export?wallet=${walletB.address}`, {
        "x-wallet-address": walletB.address,
        "x-wallet-timestamp": String(timestamp),
        "x-wallet-signature": walletA.sign(timestamp)
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHORIZED");
      await app.close();
    });

    it("rejects a signature over another wallet's challenge text", async () => {
      const walletA = createTestWallet();
      const walletB = createTestWallet();
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });
      const timestamp = Date.now();

      // A signs a challenge naming B, then presents it as its own.
      const res = await get(app, `/actions/export?wallet=${walletA.address}`, {
        "x-wallet-address": walletA.address,
        "x-wallet-timestamp": String(timestamp),
        "x-wallet-signature": walletA.signMessage(buildExportChallenge(walletB.address, timestamp))
      });

      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("rejects an unauthenticated export outright", async () => {
      const wallet = createTestWallet();
      const prisma = getMockPrisma({ [wallet.address]: [actionRow(wallet.address)] });
      const app = buildApp({ prisma, internalSecret: INTERNAL_SECRET });

      const res = await get(app, `/actions/export?wallet=${wallet.address}`);

      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHORIZED");
      expect(prisma.actionLedger.findMany).not.toHaveBeenCalled();
      await app.close();
    });

    it("stays closed when no API_KEY is configured", async () => {
      // requireApiKey no-ops without a key; export must not inherit that.
      const wallet = createTestWallet();
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });

      const res = await get(app, `/actions/export?wallet=${wallet.address}`);

      expect(res.statusCode).toBe(401);
      await app.close();
    });
  });

  describe("authorized wallet-owner export", () => {
    it("returns the wallet's own history as JSON", async () => {
      const wallet = createTestWallet();
      const prisma = getMockPrisma({ [wallet.address]: [actionRow(wallet.address)] });
      const app = buildApp({ prisma, internalSecret: INTERNAL_SECRET });

      const res = await get(app, `/actions/export?wallet=${wallet.address}`, wallet.authHeaders());

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].wallet_address).toBe(wallet.address);
      await app.close();
    });

    it("returns the wallet's own history as CSV with a download header", async () => {
      const wallet = createTestWallet();
      const prisma = getMockPrisma({ [wallet.address]: [actionRow(wallet.address)] });
      const app = buildApp({ prisma, internalSecret: INTERNAL_SECRET });

      const res = await get(
        app,
        `/actions/export?wallet=${wallet.address}&format=csv`,
        wallet.authHeaders()
      );

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/csv");
      expect(res.headers["content-disposition"]).toContain("attachment");
      const lines = res.body.trim().split("\n");
      expect(lines[0]).toContain("action_type");
      expect(lines).toHaveLength(2);
      await app.close();
    });

    it("honours from, to and limit for an authorized caller", async () => {
      const wallet = createTestWallet();
      const prisma = getMockPrisma({ [wallet.address]: [actionRow(wallet.address)] });
      const app = buildApp({ prisma, internalSecret: INTERNAL_SECRET });

      const res = await get(
        app,
        `/actions/export?wallet=${wallet.address}&from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z&limit=10`,
        wallet.authHeaders()
      );

      expect(res.statusCode).toBe(200);
      expect(prisma.actionLedger.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ walletAddress: wallet.address }), take: 10 })
      );
      await app.close();
    });
  });

  describe("signed challenge handling", () => {
    it("rejects an expired signature", async () => {
      const wallet = createTestWallet();
      const app = buildApp({
        prisma: getMockPrisma(),
        internalSecret: INTERNAL_SECRET,
        exportSignatureTtlMs: 1000
      });

      const stale = Date.now() - 60_000;
      const res = await get(app, `/actions/export?wallet=${wallet.address}`, wallet.authHeaders(stale));

      expect(res.statusCode).toBe(401);
      expect(res.json().error.message).toContain("expired");
      await app.close();
    });

    it("rejects a signature timestamped far in the future", async () => {
      const wallet = createTestWallet();
      const app = buildApp({
        prisma: getMockPrisma(),
        internalSecret: INTERNAL_SECRET,
        exportSignatureTtlMs: 1000
      });

      const future = Date.now() + 60_000;
      const res = await get(app, `/actions/export?wallet=${wallet.address}`, wallet.authHeaders(future));

      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("rejects partial wallet auth headers", async () => {
      const wallet = createTestWallet();
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });

      const res = await get(app, `/actions/export?wallet=${wallet.address}`, {
        "x-wallet-address": wallet.address
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error.message).toContain("x-wallet-signature");
      await app.close();
    });

    it("rejects a malformed wallet address in the auth header", async () => {
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });

      const res = await get(app, "/actions/export?wallet=GABC", {
        "x-wallet-address": "GABC",
        "x-wallet-timestamp": String(Date.now()),
        "x-wallet-signature": "AA=="
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error.message).toContain("valid Stellar address");
      await app.close();
    });

    it("rejects a non-numeric timestamp", async () => {
      const wallet = createTestWallet();
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });

      const res = await get(app, `/actions/export?wallet=${wallet.address}`, {
        ...wallet.authHeaders(),
        "x-wallet-timestamp": "yesterday"
      });

      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("rejects a garbage signature", async () => {
      const wallet = createTestWallet();
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });

      const res = await get(app, `/actions/export?wallet=${wallet.address}`, {
        ...wallet.authHeaders(),
        "x-wallet-signature": "bm90LWEtc2lnbmF0dXJl"
      });

      expect(res.statusCode).toBe(401);
      await app.close();
    });
  });

  describe("service consumers", () => {
    it("lets an internal service export any wallet", async () => {
      const wallet = createTestWallet();
      const prisma = getMockPrisma({ [wallet.address]: [actionRow(wallet.address)] });
      const app = buildApp({ prisma, internalSecret: INTERNAL_SECRET });

      const res = await get(app, `/actions/export?wallet=${wallet.address}`, {
        "x-internal-secret": INTERNAL_SECRET
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data).toHaveLength(1);
      await app.close();
    });

    it("lets an api-key service export any wallet", async () => {
      const wallet = createTestWallet();
      const prisma = getMockPrisma({ [wallet.address]: [actionRow(wallet.address)] });
      const app = buildApp({ prisma, internalSecret: INTERNAL_SECRET, apiKey: API_KEY });

      const res = await get(app, `/actions/export?wallet=${wallet.address}`, {
        "x-api-key": API_KEY
      });

      expect(res.statusCode).toBe(200);
      await app.close();
    });

    it("rejects a wrong internal secret", async () => {
      const wallet = createTestWallet();
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });

      const res = await get(app, `/actions/export?wallet=${wallet.address}`, {
        "x-internal-secret": "wrong-secret-value-1234567"
      });

      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("rejects a wrong api key", async () => {
      const wallet = createTestWallet();
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET, apiKey: API_KEY });

      const res = await get(app, `/actions/export?wallet=${wallet.address}`, {
        "x-api-key": "x".repeat(32)
      });

      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("rejects an api key when none is configured", async () => {
      const wallet = createTestWallet();
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });

      const res = await get(app, `/actions/export?wallet=${wallet.address}`, {
        "x-api-key": API_KEY
      });

      expect(res.statusCode).toBe(401);
      await app.close();
    });
  });

  describe("error shape", () => {
    it("uses the project's standard error envelope", async () => {
      const wallet = createTestWallet();
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });

      const res = await get(app, `/actions/export?wallet=${wallet.address}`);

      const body = res.json();
      expect(body.error).toMatchObject({
        code: "UNAUTHORIZED",
        status_code: 401
      });
      expect(typeof body.error.message).toBe("string");
      expect(typeof body.error.error_id).toBe("string");
      await app.close();
    });

    it("still validates the query once the caller is authorized", async () => {
      const wallet = createTestWallet();
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });

      const res = await get(
        app,
        `/actions/export?wallet=${wallet.address}&format=pdf`,
        wallet.authHeaders()
      );

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("INVALID_PAYLOAD");
      await app.close();
    });
  });
});
