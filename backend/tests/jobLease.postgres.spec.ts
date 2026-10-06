import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import pino from "pino";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";
import { seedAction } from "./helpers/factory.js";
import { JobLeaseService, PrismaJobLeaseStore, type JobLeaseContext } from "../src/services/jobLeaseService.js";
import { sweepOrphans } from "../src/services/reconciler.js";
import { QuestService } from "../src/services/questService.js";
import { LedgerService } from "../src/services/ledger.js";
import { StellarIndexer, defaultXdrDecoder } from "../src/services/stellarIndexer.js";

const logger = pino({ level: "silent" });

describe("PostgreSQL job commit fencing", () => {
  let db: TestDb;
  beforeAll(async () => { db = await startTestDb(); });
  afterAll(async () => { await db?.stop(); });
  beforeEach(async () => { await resetDb(db.prisma); });

  function service(ownerId: string) {
    return new JobLeaseService({ prisma: db.prisma, logger, ownerId, ttlMs: 30_000, heartbeatMs: 60_000 });
  }

  async function expire(jobName: string) {
    await db.prisma.$executeRaw`
      UPDATE job_leases SET expires_at = clock_timestamp() - interval '1 second'
      WHERE job_name = ${jobName}
    `;
  }

  it("uses the database clock and does not reacquire a live owner ID", async () => {
    const store = new PrismaJobLeaseStore(db.prisma);
    const acquired = await store.tryAcquire("job", "owner", 30_000, new Date(0));
    expect(acquired.acquired).toBe(true);
    expect((await store.tryAcquire("job", "other", 30_000, new Date("2100-01-01"))).acquired).toBe(false);
    expect((await store.tryAcquire("job", "owner", 30_000)).acquired).toBe(false);
    if (!acquired.acquired) throw new Error("lease acquisition failed");
    expect((await store.renew("job", "owner", acquired.fenceToken, 30_000, new Date(0))).renewed).toBe(true);
  });

  it("rolls domain writes back if expiry is observed at the commit boundary", async () => {
    const result = await service("a").runWithLease("job", async (lease) => {
      await lease.transaction(async (tx) => {
        await tx.pendingEvent.create({ data: { txHash: "expired", sorobanEventId: "1", eventPayload: {}, statusHint: "confirmed" } });
        // Exercise the final SQL expiry check without a timing-dependent sleep.
        await tx.$executeRaw`
          UPDATE job_leases SET expires_at = clock_timestamp() - interval '1 second'
          WHERE job_name = 'job'
        `;
      });
    });
    expect(result.status).toBe("fence_lost");
    expect(await db.prisma.pendingEvent.count()).toBe(0);
  });

  it("rolls back a cancelled transaction before handing ownership to another worker", async () => {
    const store = new PrismaJobLeaseStore(db.prisma);
    const acquired = await store.tryAcquire("job", "owner", 30_000);
    if (!acquired.acquired) throw new Error("lease acquisition failed");
    const abort = new AbortController();
    await expect(store.runFenced("job", "owner", acquired.fenceToken, abort.signal, async (tx) => {
      if (!tx) throw new Error("PostgreSQL transaction missing");
      await tx.pendingEvent.create({ data: { txHash: "cancelled", sorobanEventId: "2", eventPayload: {}, statusHint: "confirmed" } });
      abort.abort(new Error("worker shutdown"));
    })).rejects.toThrow("worker shutdown");
    expect(await db.prisma.pendingEvent.count()).toBe(0);
  });

  it("prevents a stale reconciler from orphaning or pruning rows after takeover", async () => {
    const action = await seedAction(db.prisma, { status: "submitted", txHash: "pending" });
    await db.prisma.actionLedger.update({ where: { id: action.id }, data: { updatedAt: new Date(0) } });
    await db.prisma.pendingEvent.create({ data: { txHash: "old", sorobanEventId: "3", eventPayload: {}, statusHint: "confirmed", receivedAt: new Date(0) } });
    const result = await service("a").runWithLease("cron:reconciler", async (lease) => {
      await expire(lease.jobName);
      expect((await service("b").runWithLease(lease.jobName, async () => undefined)).status).toBe("ran");
      await sweepOrphans(db.prisma, { ttlMinutes: 1 }, lease);
    });
    expect(result.status).toBe("fence_lost");
    expect((await db.prisma.actionLedger.findUnique({ where: { id: action.id } }))?.status).toBe("submitted");
    expect(await db.prisma.pendingEvent.count()).toBe(1);
    const live = await service("c").runWithLease("cron:reconciler", (lease) => sweepOrphans(db.prisma, { ttlMinutes: 1 }, lease));
    expect(live.status).toBe("ran");
    if (live.status === "ran") expect(live.value).toEqual({ orphaned: 1, prunedEvents: 1 });
  });

  it("fences quest writes and never substitutes the unguarded outer Prisma client", async () => {
    const quests = new QuestService(db.prisma);
    const result = await service("a").runWithLease("cron:quest", async (lease) => {
      await expire(lease.jobName);
      await service("b").runWithLease(lease.jobName, async () => undefined);
      await quests.evaluateWallet("wallet", lease);
    });
    expect(result.status).toBe("fence_lost");
    expect(await db.prisma.userQuest.count()).toBe(0);
    expect((await service("c").runWithLease("cron:quest", (lease) => quests.evaluateWallet("wallet", lease))).status).toBe("ran");
    expect(await db.prisma.userQuest.count()).toBeGreaterThan(0);
  });

  it("rejects an indexer result fetched under a superseded lease without moving its cursor", async () => {
    const ledger = new LedgerService(db.prisma);
    let captured: JobLeaseContext | undefined;
    const indexer = new StellarIndexer({
      ledger,
      decoder: defaultXdrDecoder,
      source: {
        async fetchEvents({ signal }) {
          expect(signal).toBe(captured?.signal);
          await expire("cron:indexer");
          await service("b").runWithLease("cron:indexer", async () => undefined);
          return [{ id: "4", ledger: 40, txHash: "stale-fetch", contractId: "C", topicXdr: [], valueXdr: "e30=", successful: true }];
        }
      }
    });
    const result = await service("a").runWithLease("cron:indexer", async (lease) => {
      captured = lease;
      return indexer.tick(lease);
    });
    expect(result.status).toBe("fence_lost");
    expect(await db.prisma.pendingEvent.count()).toBe(0);
    expect(await ledger.getIndexerCheckpoint()).toBeNull();
    expect(indexer.getCursor()).toBeNull();
  });

  it("reloads a replacement owner's checkpoint and commits progress directly under its fence", async () => {
    const cache = { getCheckpoint: vi.fn(), setCheckpoint: vi.fn(), setPendingEvent: vi.fn() };
    const ledger = new LedgerService(db.prisma, cache as never);
    const fetchEvents = vi.fn(async (_opts: { cursor: string | null; limit: number; signal?: AbortSignal }) => [{ id: "6", ledger: 60, txHash: "live-fetch", contractId: "C", topicXdr: [], valueXdr: "e30=", successful: true }]);
    const indexer = new StellarIndexer({ ledger, decoder: defaultXdrDecoder, source: { fetchEvents } });
    await ledger.updateIndexerCheckpoint({ latestLedger: 50, lastProcessedEventId: "5", success: true });
    const result = await service("a").runWithLease("cron:indexer", (lease) => indexer.tick(lease));
    expect(result.status).toBe("ran");
    expect(fetchEvents.mock.calls[0]?.[0]).toMatchObject({ cursor: "5" });
    expect((await ledger.getIndexerCheckpoint())?.lastProcessedEventId).toBe("6");
    expect(await db.prisma.pendingEvent.count()).toBe(1);
    expect(cache.getCheckpoint).not.toHaveBeenCalled();
    expect(cache.setCheckpoint).not.toHaveBeenCalled();
    expect(cache.setPendingEvent).not.toHaveBeenCalled();
  });

  // PGlite can execute the exact SQL and commit/rollback tests above, but has
  // one PostgreSQL session. Only native PostgreSQL proves lock contention.
  it.skipIf(process.env.VAULTQUEST_TEST_SINGLE_SESSION === "1")("holds the lease row lock until domain commit across PostgreSQL connections", async () => {
    const other = new PrismaClient({ datasources: { db: { url: db.databaseUrl } } });
    const firstStore = new PrismaJobLeaseStore(db.prisma);
    const secondStore = new PrismaJobLeaseStore(other);
    const acquired = await firstStore.tryAcquire("job", "a", 30_000);
    if (!acquired.acquired) throw new Error("lease acquisition failed");
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const writing = firstStore.runFenced("job", "a", acquired.fenceToken, new AbortController().signal, async (tx) => {
      if (!tx) throw new Error("PostgreSQL transaction missing");
      await tx.pendingEvent.create({ data: { txHash: "locked", sorobanEventId: "7", eventPayload: {}, statusHint: "confirmed" } });
      entered();
      await gate;
    });
    try {
      await started;
      const contender = secondStore.tryAcquire("job", "b", 30_000);
      let waiting = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const rows = await db.prisma.$queryRaw<Array<{ waiting: boolean }>>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock'
              AND query LIKE '%INSERT INTO job_leases%') AS waiting
        `;
        if (rows[0]?.waiting) { waiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(true);
      release();
      await writing;
      expect((await contender).acquired).toBe(false);
      expect(await db.prisma.pendingEvent.count()).toBe(1);
      await firstStore.release("job", "a", acquired.fenceToken);
      expect((await secondStore.tryAcquire("job", "b", 30_000)).acquired).toBe(true);
      const staleWrite = vi.fn(async () => undefined);
      await expect(firstStore.runFenced("job", "a", acquired.fenceToken, new AbortController().signal, staleWrite)).rejects.toThrow("no longer current");
      expect(staleWrite).not.toHaveBeenCalled();
    } finally {
      release();
      await writing.catch(() => undefined);
      await other.$disconnect();
    }
  });
});
