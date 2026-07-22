import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";
import { seedAction } from "./helpers/factory.js";
import { LedgerService } from "../src/services/ledger.js";
import {
  StellarIndexer,
  defaultXdrDecoder,
  type RawHorizonEvent,
  type HorizonEventSource,
  type XdrDecoder
} from "../src/services/stellarIndexer.js";

function b64(value: unknown): string {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64");
}

function makeEvent(overrides: Partial<RawHorizonEvent> = {}): RawHorizonEvent {
  return {
    id: overrides.id ?? "1",
    ledger: overrides.ledger ?? 100,
    txHash: overrides.txHash ?? "tx_1",
    contractId: overrides.contractId ?? "CDRIP",
    topicXdr: overrides.topicXdr ?? [b64("deposit")],
    valueXdr: overrides.valueXdr ?? b64({ amount: "100", vault_id: "v1" }),
    successful: overrides.successful ?? true
  };
}

/** Event source backed by a fixed in-memory list, paged by cursor. */
function staticSource(events: RawHorizonEvent[]): HorizonEventSource {
  return {
    async fetchEvents({ cursor, limit }) {
      const start = cursor ? events.findIndex((e) => e.id === cursor) + 1 : 0;
      return events.slice(start, start + limit);
    }
  };
}

describe("StellarIndexer", () => {
  let db: TestDb;
  let ledger: LedgerService;
  beforeAll(async () => { db = await startTestDb(); });
  afterAll(async () => { await db.stop(); });
  beforeEach(async () => {
    await resetDb(db.prisma);
    ledger = new LedgerService(db.prisma);
  });

  it("decodes XDR payloads and imports events as pending_events when unmatched", async () => {
    const indexer = new StellarIndexer({
      ledger,
      source: staticSource([makeEvent({ id: "1", txHash: "tx_a" })]),
      decoder: defaultXdrDecoder
    });

    const result = await indexer.tick();
    expect(result.processed).toBe(1);
    expect(result.imported).toBe(1);
    expect(result.cursor).toBe("1");

    const parked = await db.prisma.pendingEvent.findUnique({ where: { txHash: "tx_a" } });
    expect(parked).not.toBeNull();
    expect((parked!.eventPayload as any).type).toBe("deposit");
    expect((parked!.eventPayload as any).vault_id).toBe("v1");
  });

  it("confirms a matching action on its tx hash", async () => {
    const action = await seedAction(db.prisma, { status: "submitted", txHash: "tx_match" });
    const indexer = new StellarIndexer({
      ledger,
      source: staticSource([makeEvent({ id: "1", txHash: "tx_match" })]),
      decoder: defaultXdrDecoder
    });

    await indexer.tick();
    const refreshed = await db.prisma.actionLedger.findUnique({ where: { id: action.id } });
    expect(refreshed?.status).toBe("confirmed");
  });

  it("is idempotent across re-runs and safely handles duplicate tx hashes", async () => {
    const events = [
      makeEvent({ id: "1", txHash: "tx_dup" }),
      makeEvent({ id: "2", txHash: "tx_dup" })
    ];
    const indexer = new StellarIndexer({ ledger, source: staticSource(events), decoder: defaultXdrDecoder });

    const first = await indexer.tick();
    expect(first.duplicates).toBe(1); // second event shares the tx hash

    // Re-running from the start must not create a second pending_event row.
    indexer.setCursor(null);
    await indexer.tick();
    const rows = await db.prisma.pendingEvent.findMany({ where: { txHash: "tx_dup" } });
    expect(rows).toHaveLength(1);
  });

  it("marks reverted transactions accordingly", async () => {
    const action = await seedAction(db.prisma, { status: "submitted", txHash: "tx_rev" });
    const indexer = new StellarIndexer({
      ledger,
      source: staticSource([makeEvent({ id: "1", txHash: "tx_rev", successful: false })]),
      decoder: defaultXdrDecoder
    });

    await indexer.tick();
    const refreshed = await db.prisma.actionLedger.findUnique({ where: { id: action.id } });
    expect(refreshed?.status).toBe("reverted");
  });

  describe("resilience: malformed events and partial failures", () => {
    it("handles decoder exceptions without stopping the batch", async () => {
      const throwingDecoder: XdrDecoder = {
        decode(event: RawHorizonEvent) {
          if (event.txHash === "tx_throw") {
            throw new Error("simulated decoder crash");
          }
          return { type: "ok", data: true };
        }
      };

      const events = [
        makeEvent({ id: "1", txHash: "tx_ok_before" }),
        makeEvent({ id: "2", txHash: "tx_throw" }),
        makeEvent({ id: "3", txHash: "tx_ok_after" })
      ];

      const indexer = new StellarIndexer({
        ledger,
        source: staticSource(events),
        decoder: throwingDecoder
      });

      const result = await indexer.tick();
      expect(result.processed).toBe(3);
      expect(result.imported).toBe(2);
      expect(result.malformed).toBe(1);
      expect(result.cursor).toBe("3");

      const before = await db.prisma.pendingEvent.findUnique({ where: { txHash: "tx_ok_before" } });
      const after = await db.prisma.pendingEvent.findUnique({ where: { txHash: "tx_ok_after" } });
      expect(before).not.toBeNull();
      expect(after).not.toBeNull();
    });

    it("handles mixed successful, duplicate, and decoder-failed events", async () => {
      const action = await seedAction(db.prisma, { status: "submitted", txHash: "tx_existing" });

      const throwingDecoder: XdrDecoder = {
        decode(event: RawHorizonEvent) {
          if (event.txHash === "tx_bad") {
            throw new Error("decode error");
          }
          return { type: "ok" };
        }
      };

      const events = [
        makeEvent({ id: "1", txHash: "tx_existing" }),
        makeEvent({ id: "2", txHash: "tx_bad" }),
        makeEvent({ id: "3", txHash: "tx_new" })
      ];

      const indexer = new StellarIndexer({
        ledger,
        source: staticSource(events),
        decoder: throwingDecoder
      });

      const result = await indexer.tick();
      expect(result.processed).toBe(3);
      expect(result.imported).toBe(2);
      expect(result.malformed).toBe(1);
      expect(result.cursor).toBe("3");

      const confirmed = await db.prisma.actionLedger.findUnique({ where: { id: action.id } });
      expect(confirmed?.status).toBe("confirmed");
    });

    it("advances cursor safely when all events in batch fail decoding", async () => {
      const alwaysThrowDecoder: XdrDecoder = {
        decode() {
          throw new Error("always fails");
        }
      };

      const events = [
        makeEvent({ id: "10", txHash: "tx_bad1" }),
        makeEvent({ id: "11", txHash: "tx_bad2" }),
        makeEvent({ id: "12", txHash: "tx_bad3" })
      ];

      const indexer = new StellarIndexer({
        ledger,
        source: staticSource(events),
        decoder: alwaysThrowDecoder
      });

      const result = await indexer.tick();
      expect(result.processed).toBe(3);
      expect(result.imported).toBe(0);
      expect(result.malformed).toBe(3);
      expect(result.cursor).toBe("12");

      // Next tick with same cursor should fetch no new events (cursor is at end).
      const result2 = await indexer.tick();
      expect(result2.processed).toBe(0);
    });

    it("does not create duplicate confirmations on retry/replay", async () => {
      const action = await seedAction(db.prisma, { status: "submitted", txHash: "tx_retry" });

      const events = [makeEvent({ id: "1", txHash: "tx_retry" })];
      const indexer = new StellarIndexer({
        ledger,
        source: staticSource(events),
        decoder: defaultXdrDecoder
      });

      // First tick confirms the action.
      await indexer.tick();
      const afterFirst = await db.prisma.actionLedger.findUnique({ where: { id: action.id } });
      expect(afterFirst?.status).toBe("confirmed");

      // Replay from cursor null — should be idempotent.
      indexer.setCursor(null);
      await indexer.tick();
      const afterReplay = await db.prisma.actionLedger.findUnique({ where: { id: action.id } });
      expect(afterReplay?.status).toBe("confirmed");

      // Only one pending_event row should exist (if any).
      const pending = await db.prisma.pendingEvent.findMany({ where: { txHash: "tx_retry" } });
      expect(pending).toHaveLength(0);
    });

    it("handles partial fetch failure gracefully", async () => {
      let callCount = 0;
      const flakySource: HorizonEventSource = {
        async fetchEvents({ cursor, limit }) {
          callCount++;
          // Simulate: first call returns partial batch, second call returns rest.
          if (callCount === 1) {
            return [makeEvent({ id: "1", txHash: "tx_partial1" })];
          }
          return [
            makeEvent({ id: "2", txHash: "tx_partial2" }),
            makeEvent({ id: "3", txHash: "tx_partial3" })
          ];
        }
      };

      const indexer = new StellarIndexer({
        ledger,
        source: flakySource,
        decoder: defaultXdrDecoder
      });

      const result1 = await indexer.tick();
      expect(result1.processed).toBe(1);
      expect(result1.imported).toBe(1);
      expect(result1.cursor).toBe("1");

      const result2 = await indexer.tick();
      expect(result2.processed).toBe(2);
      expect(result2.imported).toBe(2);
      expect(result2.cursor).toBe("3");

      const all = await db.prisma.pendingEvent.findMany();
      expect(all).toHaveLength(3);
    });

    it("handles decoder that returns null/undefined payload", async () => {
      const nullDecoder: XdrDecoder = {
        decode() {
          return null as unknown as Record<string, unknown>;
        }
      };

      const events = [
        makeEvent({ id: "1", txHash: "tx_null" }),
        makeEvent({ id: "2", txHash: "tx_after_null" })
      ];

      const indexer = new StellarIndexer({
        ledger,
        source: staticSource(events),
        decoder: nullDecoder
      });

      const result = await indexer.tick();
      expect(result.processed).toBe(2);
      expect(result.imported).toBe(0);
      expect(result.malformed).toBe(2);
      expect(result.cursor).toBe("2");
    });

    it("handles decoder that returns array payload", async () => {
      const arrayDecoder: XdrDecoder = {
        decode() {
          return ["not", "an", "object"] as unknown as Record<string, unknown>;
        }
      };

      const events = [
        makeEvent({ id: "1", txHash: "tx_array" }),
        makeEvent({ id: "2", txHash: "tx_after_array" })
      ];

      const indexer = new StellarIndexer({
        ledger,
        source: staticSource(events),
        decoder: arrayDecoder
      });

      const result = await indexer.tick();
      expect(result.processed).toBe(2);
      expect(result.imported).toBe(0);
      expect(result.malformed).toBe(2);
      expect(result.cursor).toBe("2");
    });
  });

  it("resumes from the persisted processed-event cursor after downtime", async () => {
    await db.prisma.indexerCheckpoint.upsert({
      where: { id: "singleton" },
      create: {
        id: "singleton",
        latestLedger: 102,
        lastProcessedEventId: "2",
        lastSyncTime: new Date("2026-06-23T00:00:00Z"),
        lastError: null,
        lastSuccessSyncTime: new Date("2026-06-23T00:00:00Z")
      },
      update: {
        latestLedger: 102,
        lastProcessedEventId: "2",
        lastSyncTime: new Date("2026-06-23T00:00:00Z"),
        lastError: null,
        lastSuccessSyncTime: new Date("2026-06-23T00:00:00Z")
      }
    });

    let seenCursor: string | null = null;
    const indexer = new StellarIndexer({
      ledger,
      source: {
        async fetchEvents({ cursor, limit }) {
          seenCursor = cursor;
          expect(limit).toBe(50);
          return cursor === "2"
            ? [makeEvent({ id: "3", ledger: 103, txHash: "tx_resume" })]
            : [];
        }
      },
      decoder: defaultXdrDecoder
    });

    const result = await indexer.tick();

    expect(seenCursor).toBe("2");
    expect(result.cursor).toBe("3");
    expect(result.processed).toBe(1);
    expect(result.imported).toBe(1);

    const checkpoint = await db.prisma.indexerCheckpoint.findUnique({ where: { id: "singleton" } });
    expect(checkpoint?.lastProcessedEventId).toBe("3");
    expect(checkpoint?.latestLedger).toBe(103);

    const parked = await db.prisma.pendingEvent.findUnique({ where: { txHash: "tx_resume" } });
    expect(parked).not.toBeNull();
  });
});
