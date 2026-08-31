/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";
import { buildApp } from "../src/app.js";
import { injectWithCsrf as origInjectWithCsrf } from "./helpers/csrf.js";
const injectWithCsrf = (app: any, method: any, url: any, payload?: any, headers = {}) => origInjectWithCsrf(app, method, url, payload, { ...headers, "x-internal-secret": "test-secret" });
import type { FastifyInstance } from "fastify";

describe("Saved pools API", () => {
  let db: TestDb;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await startTestDb();
    app = buildApp({ prisma: db.prisma, internalSecret: "test-secret", allowUnauthenticatedDevApi: true });
  });

  afterAll(async () => {
    await app.close();
    await db.stop();
  });

  beforeEach(async () => {
    await resetDb(db.prisma);
  });

  const walletAddress = "GSAVED1234567890123456789012345678901234567890123456789";
  const samplePool = {
    pool_id: "pool-1",
    pool_name: "Test Pool",
    status: "open" as const,
    tvl: "10000",
    asset: "USDC",
    participant_count: 5,
    expected_yield: "5.2% APY",
    prize: "500 USDC",
    opens_at: "2026-01-01T00:00:00.000Z",
    locks_at: "2026-06-01T00:00:00.000Z",
    draws_at: "2026-07-01T00:00:00.000Z",
  };

  it("saves a pool and returns 201", async () => {
    const res = await injectWithCsrf(app, "POST", "/saved-pools", {
        wallet_address: walletAddress,
        pool: samplePool,
      }, { "content-type": "application/json" });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.saved.wallet_address).toBe(walletAddress);
    expect(body.data.saved.pool_id).toBe("pool-1");
    expect(body.data.saved.pool_name).toBe("Test Pool");
    expect(body.data.saved.status).toBe("open");
  });

  it("returns 200 on re-saving an already saved pool (upsert)", async () => {
    await injectWithCsrf(app, "POST", "/saved-pools", { wallet_address: walletAddress, pool: samplePool }, { "content-type": "application/json" });

    const res = await injectWithCsrf(app, "POST", "/saved-pools", { wallet_address: walletAddress, pool: samplePool }, { "content-type": "application/json" });

    expect(res.statusCode).toBe(200);
  });

  it("lists saved pools for a wallet", async () => {
    const pool2 = { ...samplePool, pool_id: "pool-2", pool_name: "Pool Two" };

    await injectWithCsrf(app, "POST", "/saved-pools", { wallet_address: walletAddress, pool: samplePool }, { "content-type": "application/json" });
    await injectWithCsrf(app, "POST", "/saved-pools", { wallet_address: walletAddress, pool: pool2 }, { "content-type": "application/json" });

    const res = await app.inject({ method: "GET", url: `/saved-pools?wallet=${walletAddress}`, headers: { "x-internal-secret": "test-secret" } });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(2);
    expect(res.json().data.map((p: any) => p.pool_id)).toEqual(
      expect.arrayContaining(["pool-1", "pool-2"])
    );
  });

  it("unsaves a pool", async () => {
    await injectWithCsrf(app, "POST", "/saved-pools", { wallet_address: walletAddress, pool: samplePool }, { "content-type": "application/json" });

    const del = await injectWithCsrf(app, "DELETE", `/saved-pools/pool-1?wallet=${walletAddress}`,);

    expect(del.statusCode).toBe(200);
    expect(del.json().data.deleted).toBe(1);

    const list = await app.inject({ method: "GET", url: `/saved-pools?wallet=${walletAddress}`, headers: { "x-internal-secret": "test-secret" } });
    expect(list.json().data).toHaveLength(0);
  });

  it("returns empty list for wallet with no saved pools", async () => {
    const res = await app.inject({ method: "GET", url: `/saved-pools?wallet=${walletAddress}`, headers: { "x-internal-secret": "test-secret" } });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([]);
  });

  it("rejects save with missing wallet address", async () => {
    const res = await injectWithCsrf(app, "POST", "/saved-pools", { pool: samplePool }, { "content-type": "application/json" });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_PAYLOAD");
  });

  it("rejects save with invalid pool data", async () => {
    const res = await injectWithCsrf(app, "POST", "/saved-pools", {
        wallet_address: walletAddress,
        pool: { pool_id: "p1", pool_name: "Bad", status: "unknown" },
      }, { "content-type": "application/json" });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_PAYLOAD");
  });

  it("isolates saved pools between different wallets", async () => {
    const walletB = "GSAVED9876543210987654321098765432109876543210987654321";

    await injectWithCsrf(app, "POST", "/saved-pools", { wallet_address: walletAddress, pool: samplePool }, { "content-type": "application/json" });

    const resB = await app.inject({ method: "GET", url: `/saved-pools?wallet=${walletB}`, headers: { "x-internal-secret": "test-secret" } });
    expect(resB.json().data).toHaveLength(0);
  });

  describe("cross-user authorization", () => {
    const walletA = "GSAVEDAAAA111111111111111111111111111111111111111111111";
    const walletB = "GSAVEDBBBB222222222222222222222222222222222222222222222";
    const poolShared = { ...samplePool, pool_id: "pool-shared", pool_name: "Shared Pool" };
    const poolAOnly = { ...samplePool, pool_id: "pool-a-only", pool_name: "A Only" };
    const poolBOnly = { ...samplePool, pool_id: "pool-b-only", pool_name: "B Only" };

    async function save(wallet: string, pool: typeof samplePool) {
      return injectWithCsrf(app, "POST", "/saved-pools", { wallet_address: wallet, pool }, { "content-type": "application/json" });
    }

    it("keeps overlapping and distinct saved pools scoped per wallet", async () => {
      await save(walletA, poolShared);
      await save(walletA, poolAOnly);
      await save(walletB, poolShared);
      await save(walletB, poolBOnly);

      const listA = await app.inject({ method: "GET", url: `/saved-pools?wallet=${walletA}`, headers: { "x-internal-secret": "test-secret" } });
      const listB = await app.inject({ method: "GET", url: `/saved-pools?wallet=${walletB}`, headers: { "x-internal-secret": "test-secret" } });

      expect(listA.json().data.map((p: any) => p.pool_id).sort()).toEqual(
        ["pool-a-only", "pool-shared"].sort()
      );
      expect(listB.json().data.map((p: any) => p.pool_id).sort()).toEqual(
        ["pool-b-only", "pool-shared"].sort()
      );
    });

    it("does not let wallet B delete wallet A's saved pool by guessing the poolId", async () => {
      await save(walletA, poolAOnly);

      const del = await injectWithCsrf(app, "DELETE", `/saved-pools/${poolAOnly.pool_id}?wallet=${walletB}`,);
      expect(del.statusCode).toBe(200);
      expect(del.json().data.deleted).toBe(0); // no rows matched wallet B's scope

      const listA = await app.inject({ method: "GET", url: `/saved-pools?wallet=${walletA}`, headers: { "x-internal-secret": "test-secret" } });
      expect(listA.json().data.map((p: any) => p.pool_id)).toContain(poolAOnly.pool_id);
    });

    it("lets wallet A and wallet B independently save/unsave the same poolId without affecting each other", async () => {
      await save(walletA, poolShared);
      await save(walletB, poolShared);

      const delA = await injectWithCsrf(app, "DELETE", `/saved-pools/${poolShared.pool_id}?wallet=${walletA}`,);
      expect(delA.json().data.deleted).toBe(1);

      const listA = await app.inject({ method: "GET", url: `/saved-pools?wallet=${walletA}`, headers: { "x-internal-secret": "test-secret" } });
      const listB = await app.inject({ method: "GET", url: `/saved-pools?wallet=${walletB}`, headers: { "x-internal-secret": "test-secret" } });

      expect(listA.json().data).toHaveLength(0);
      expect(listB.json().data.map((p: any) => p.pool_id)).toContain(poolShared.pool_id);
    });

    it("does not let wallet B's re-save of a shared poolId overwrite wallet A's record", async () => {
      await save(walletA, poolShared);
      await save(walletB, { ...poolShared, pool_name: "Renamed by B" });

      const listA = await app.inject({ method: "GET", url: `/saved-pools?wallet=${walletA}`, headers: { "x-internal-secret": "test-secret" } });
      expect(listA.json().data[0].pool_name).toBe(poolShared.pool_name);
    });
  });
});
