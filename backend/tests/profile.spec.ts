/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";
import { buildApp } from "../src/app.js";
import { injectWithCsrf as origInjectWithCsrf } from "./helpers/csrf.js";
import { createTestWallet } from "./helpers/wallet.js";
import { csrfHeaders } from "./helpers/csrf.js";
import type { FastifyInstance } from "fastify";

const INTERNAL_SECRET = "test-secret";
const injectSvc = (app: FastifyInstance, method: any, url: string, payload?: any, headers: Record<string, string> = {}) =>
  origInjectWithCsrf(app, method, url, payload, { ...headers, "x-internal-secret": INTERNAL_SECRET });

// Unique IPs keep the sensitive-route rate limiter from bleeding across tests.
let ipCounter = 1;
function getSigned(app: FastifyInstance, url: string, wallet: ReturnType<typeof createTestWallet>, headers: Record<string, string> = {}) {
  const remoteAddress = `192.168.60.${ipCounter++}`;
  return app.inject({ method: "GET", url, remoteAddress, headers: { ...wallet.authHeaders(), ...headers } });
}

async function putSigned(
  app: FastifyInstance,
  wallet: ReturnType<typeof createTestWallet>,
  payload: any
) {
  const remoteAddress = `192.168.61.${ipCounter++}`;
  const csrf = await csrfHeaders(app, remoteAddress);
  return app.inject({
    method: "PUT",
    url: "/profile",
    remoteAddress,
    headers: { ...csrf, ...wallet.authHeaders(), "content-type": "application/json" },
    payload
  });
}

describe("Authenticated profile contract (#134)", () => {
  let db: TestDb;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await startTestDb();
    app = buildApp({ prisma: db.prisma, internalSecret: INTERNAL_SECRET });
  });

  afterAll(async () => {
    await app.close();
    await db.stop();
  });

  beforeEach(async () => {
    await resetDb(db.prisma);
  });

  async function seedCompletedQuest(walletAddress: string, questId: string, completedAt = new Date("2026-05-01T00:00:00Z")) {
    await db.prisma.userQuest.create({
      data: { walletAddress, questId, target: 1, progress: 1, status: "completed", completedAt }
    });
  }

  describe("authorized update", () => {
    it("persists editable fields for a signed wallet owner", async () => {
      const wallet = createTestWallet();
      await seedCompletedQuest(wallet.address, "first_deposit");

      const res = await putSigned(app, wallet, {
        wallet_address: wallet.address,
        profile: { display_name: "Alice", bio: "Avid saver", badge_id: "first_deposit" }
      });

      expect(res.statusCode).toBe(200);
      const view = res.json().data;
      expect(view.wallet_address).toBe(wallet.address);
      expect(view.display_name).toBe("Alice");
      expect(view.bio).toBe("Avid saver");
      expect(view.badge_id).toBe("first_deposit");
      expect(view.achievements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ questId: "first_deposit", title: "First Steps" })
        ])
      );
    });

    it("updates a partial set of fields without clobbering the rest", async () => {
      const wallet = createTestWallet();
      await putSigned(app, wallet, {
        wallet_address: wallet.address,
        profile: { display_name: "Alice", bio: "Avid saver" }
      });

      const res = await putSigned(app, wallet, {
        wallet_address: wallet.address,
        profile: { bio: "Now a whale" }
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.display_name).toBe("Alice");
      expect(res.json().data.bio).toBe("Now a whale");
    });

    it("clears an editable field by sending null", async () => {
      const wallet = createTestWallet();
      await seedCompletedQuest(wallet.address, "first_deposit");
      await putSigned(app, wallet, {
        wallet_address: wallet.address,
        profile: { display_name: "Alice", badge_id: "first_deposit" }
      });

      const res = await putSigned(app, wallet, {
        wallet_address: wallet.address,
        profile: { display_name: null }
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.display_name).toBeNull();
      expect(res.json().data.badge_id).toBe("first_deposit");
    });
  });

  describe("cross-user denial", () => {
    it("does not let a signed wallet create or mutate another wallet's profile", async () => {
      const walletA = createTestWallet();
      const walletB = createTestWallet();

      // wallet A tries to write wallet B's profile by naming B as the wallet.
      const res = await putSigned(app, walletA, {
        wallet_address: walletB.address,
        profile: { display_name: "Intruder" }
      });

      // The guard binds wallet A only: it writes to A's own identity, and B
      // is never touched.
      expect(res.statusCode).toBe(200);
      expect(res.json().data.wallet_address).toBe(walletA.address);

      const b = await getSigned(app, `/profile?wallet=${walletB.address}`, walletB);
      expect(b.statusCode).toBe(200);
      expect(b.json().data.display_name).toBeNull();
    });
  });

  describe("validation", () => {
    it("rejects an empty profile body with no editable fields", async () => {
      const wallet = createTestWallet();
      const res = await putSigned(app, wallet, {
        wallet_address: wallet.address,
        profile: {}
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("INVALID_PAYLOAD");
    });

    it("rejects a bio that exceeds the field limit", async () => {
      const wallet = createTestWallet();
      const res = await putSigned(app, wallet, {
        wallet_address: wallet.address,
        profile: { bio: "x".repeat(601) }
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("INVALID_PAYLOAD");
    });

    it("rejects a display name that exceeds the field limit", async () => {
      const wallet = createTestWallet();
      const res = await putSigned(app, wallet, {
        wallet_address: wallet.address,
        profile: { display_name: "x".repeat(61) }
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("INVALID_PAYLOAD");
    });

    it("rejects a badge that references a quest the wallet has not completed", async () => {
      const wallet = createTestWallet();
      const res = await putSigned(app, wallet, {
        wallet_address: wallet.address,
        profile: { badge_id: "first_deposit" }
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain("badge_id");
    });
  });

  describe("duplicate identity conflict", () => {
    it("rejects a display name already held by another wallet (case-insensitive)", async () => {
      const walletA = createTestWallet();
      const walletB = createTestWallet();

      await putSigned(app, walletA, {
        wallet_address: walletA.address,
        profile: { display_name: "Saver" }
      });

      const res = await putSigned(app, walletB, {
        wallet_address: walletB.address,
        profile: { display_name: "saver" }
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("CONFLICT");
    });

    it("allows a wallet to keep its own display name", async () => {
      const walletA = createTestWallet();
      await putSigned(app, walletA, {
        wallet_address: walletA.address,
        profile: { display_name: "Saver" }
      });

      const res = await putSigned(app, walletA, {
        wallet_address: walletA.address,
        profile: { display_name: "Saver" }
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("reload persistence", () => {
    it("returns persisted edits on a fresh read (reload / another session)", async () => {
      const wallet = createTestWallet();
      await seedCompletedQuest(wallet.address, "first_deposit");
      await seedCompletedQuest(wallet.address, "save_100", new Date("2026-06-01T00:00:00Z"));

      await putSigned(app, wallet, {
        wallet_address: wallet.address,
        profile: { display_name: "Persistent Alice", badge_id: "save_100" }
      });

      // Simulate a reload with a freshly signed request in a new "session".
      const res = await getSigned(app, `/profile?wallet=${wallet.address}`, wallet);

      expect(res.statusCode).toBe(200);
      expect(res.json().data.display_name).toBe("Persistent Alice");
      expect(res.json().data.badge_id).toBe("save_100");
    });
  });

  describe("achievement derivation", () => {
    it("returns only completed quests as achievements, with catalog titles", async () => {
      const wallet = createTestWallet();
      await seedCompletedQuest(wallet.address, "first_deposit", new Date("2026-05-01T00:00:00Z"));
      await seedCompletedQuest(wallet.address, "first_win", new Date("2026-07-01T00:00:00Z"));
      // In-progress quest must NOT surface as an achievement.
      await db.prisma.userQuest.create({
        data: { walletAddress: wallet.address, questId: "save_100_three_months", target: 3, progress: 1, status: "in_progress" }
      });

      const res = await getSigned(app, `/profile?wallet=${wallet.address}`, wallet);
      expect(res.statusCode).toBe(200);
      const achievements = res.json().data.achievements;
      expect(achievements).toHaveLength(2);
      expect(achievements.map((a: any) => a.questId).sort()).toEqual(["first_deposit", "first_win"]);
      expect(achievements.find((a: any) => a.questId === "first_deposit").title).toBe("First Steps");
      expect(achievements.find((a: any) => a.questId === "first_win").title).toBe("Lucky Saver");
    });

    it("returns an empty achievements list for a wallet with no completed quests", async () => {
      const wallet = createTestWallet();
      const res = await getSigned(app, `/profile?wallet=${wallet.address}`, wallet);
      expect(res.statusCode).toBe(200);
      expect(res.json().data.achievements).toEqual([]);
    });
  });
});
