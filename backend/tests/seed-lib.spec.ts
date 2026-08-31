import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestDb, type TestDb } from "./helpers/db.js";
import { seedDatabase, deterministicUuid } from "../prisma/seed-lib.js";

const VALID_POOL_STATUSES = new Set(["open", "locked", "drawing", "settled"]);
const VALID_ACTION_STATUSES = new Set([
  "pending",
  "submitted",
  "confirmed",
  "failed",
  "reverted",
  "orphaned",
]);
const VALID_ACTION_TYPES = new Set([
  "deposit",
  "withdraw",
  "create_vault",
  "claim",
  "select_winner",
]);

describe("seedDatabase", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await startTestDb();
  });

  afterAll(async () => {
    await db.stop();
  });

  it("is idempotent: re-running produces identical logical rows with no conflicts", async () => {
    const now = new Date("2026-06-15T12:00:00.000Z").getTime();

    await seedDatabase(db.prisma, { now });
    const firstRun = {
      pools: await db.prisma.savedPool.findMany({ orderBy: { poolId: "asc" } }),
      events: await db.prisma.pendingEvent.findMany({ orderBy: { txHash: "asc" } }),
      actions: await db.prisma.actionLedger.findMany({ orderBy: { idempotencyKey: "asc" } }),
    };

    // Re-run with the same fixed timestamp — must not throw (no unique-key
    // collisions on idempotencyKey/txHash) and must yield identical content.
    await expect(seedDatabase(db.prisma, { now })).resolves.toBeUndefined();

    const secondRun = {
      pools: await db.prisma.savedPool.findMany({ orderBy: { poolId: "asc" } }),
      events: await db.prisma.pendingEvent.findMany({ orderBy: { txHash: "asc" } }),
      actions: await db.prisma.actionLedger.findMany({ orderBy: { idempotencyKey: "asc" } }),
    };

    expect(secondRun.pools).toEqual(firstRun.pools);
    expect(secondRun.events).toEqual(firstRun.events);
    expect(secondRun.actions).toEqual(firstRun.actions);
  });

  it("uses deterministic idempotency keys", () => {
    const a = deterministicUuid("a-dep-1");
    const b = deterministicUuid("a-dep-1");
    const c = deterministicUuid("a-dep-2");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    // v5-style shape: 8-4-4-4-12 hex
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("seeds only contract-valid pool and action statuses across realistic states", async () => {
    const now = new Date("2026-06-15T12:00:00.000Z").getTime();
    await seedDatabase(db.prisma, { now });

    const pools = await db.prisma.savedPool.findMany();
    const actions = await db.prisma.actionLedger.findMany();

    expect(pools.length).toBeGreaterThan(0);
    expect(actions.length).toBeGreaterThan(0);

    for (const pool of pools) {
      expect(VALID_POOL_STATUSES.has(pool.status), `${pool.poolId}=${pool.status}`).toBe(true);
    }
    for (const action of actions) {
      expect(VALID_ACTION_STATUSES.has(action.status), action.idempotencyKey).toBe(true);
      expect(VALID_ACTION_TYPES.has(action.actionType), action.idempotencyKey).toBe(true);
    }

    // Realistic lifecycle coverage: deposits, withdrawals, claims, draws, and
    // the failure states that otherwise regress silently.
    const statuses = new Set<string>(actions.map((a) => a.status));
    for (const s of VALID_ACTION_STATUSES) {
      expect(statuses.has(s), s).toBe(true);
    }
  });
});
