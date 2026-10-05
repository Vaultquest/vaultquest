import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";
import { makeIntentInput } from "./helpers/factory.js";
import { LedgerService } from "../src/services/ledger.js";
import { AppError } from "../src/errors.js";

describe("LedgerService.createAction", () => {
  let db: TestDb;
  let svc: LedgerService;

  beforeAll(async () => {
    db = await startTestDb();
    svc = new LedgerService(db.prisma);
  });
  afterAll(async () => {
    await db.stop();
  });
  beforeEach(async () => {
    await resetDb(db.prisma);
  });

  it("creates a pending action", async () => {
    const input = makeIntentInput();
    const result = await svc.createAction(input);
    expect(result.status).toBe("pending");
    expect(result.walletAddress).toBe(input.walletAddress);
    expect(result.idempotencyKey).toBe(input.idempotencyKey);
    expect(result.correlationId).toBeDefined();
  });

  it("returns same row on duplicate idempotency key with identical payload", async () => {
    const input = makeIntentInput();
    const first = await svc.createAction(input);
    const second = await svc.createAction(input);
    expect(second.id).toBe(first.id);
    expect(second.correlationId).toBe(first.correlationId);
  });

  it("rejects duplicate key with different payload", async () => {
    const input = makeIntentInput();
    await svc.createAction(input);
    await expect(
      svc.createAction({ ...input, actionPayload: { vault_id: "999", amount: "1" } })
    ).rejects.toBeInstanceOf(AppError);
  });

  it("allows different idempotency keys for same wallet and payload", async () => {
    const a = makeIntentInput({ idempotencyKey: "key-a" });
    const b = makeIntentInput({ idempotencyKey: "key-b" });
    const ra = await svc.createAction(a);
    const rb = await svc.createAction(b);
    expect(ra.id).not.toBe(rb.id);
  });
});

describe("LedgerService.attachTxHash", () => {
  let db: TestDb;
  let svc: LedgerService;

  beforeAll(async () => {
    db = await startTestDb();
    svc = new LedgerService(db.prisma);
  });
  afterAll(async () => {
    await db.stop();
  });
  beforeEach(async () => {
    await resetDb(db.prisma);
  });

  it("transitions pending -> submitted", async () => {
    const input = makeIntentInput();
    const created = await svc.createAction(input);
    const updated = await svc.attachTxHash(created.id, "tx_abc123");
    expect(updated.status).toBe("submitted");
    expect(updated.txHash).toBe("tx_abc123");
    expect(updated.submittedAt).not.toBeNull();
  });

  it("throws NOT_FOUND on unknown id", async () => {
    await expect(svc.attachTxHash("11111111-1111-1111-1111-111111111111", "tx"))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects attachTxHash on terminal row", async () => {
    const input = makeIntentInput();
    const created = await svc.createAction(input);
    await db.prisma.actionLedger.update({
      where: { id: created.id },
      data: { status: "confirmed", confirmedAt: new Date() }
    });
    await expect(svc.attachTxHash(created.id, "tx_abc"))
      .rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
  });

  it("auto-confirms when matching pending_event already exists", async () => {
    await db.prisma.pendingEvent.create({
      data: {
        txHash: "tx_race_1",
        sorobanEventId: "evt_xyz",
        eventPayload: { ok: true },
        statusHint: "confirmed"
      }
    });

    const input = makeIntentInput();
    const created = await svc.createAction(input);
    const updated = await svc.attachTxHash(created.id, "tx_race_1");

    expect(updated.status).toBe("confirmed");
    expect(updated.sorobanEventId).toBe("evt_xyz");
    expect(updated.confirmedAt).not.toBeNull();

    const consumed = await db.prisma.pendingEvent.findUnique({ where: { txHash: "tx_race_1" } });
    expect(consumed?.consumedAt).not.toBeNull();
  });

  it("is idempotent when re-attaching the same tx_hash to the same action", async () => {
    const created = await svc.createAction(makeIntentInput());
    const first = await svc.attachTxHash(created.id, "tx_retry_1");
    // A dropped response leads the client to retry the same submission.
    const second = await svc.attachTxHash(created.id, "tx_retry_1");
    expect(second.id).toBe(first.id);
    expect(second.status).toBe("submitted");
    expect(second.txHash).toBe("tx_retry_1");
  });

  it("rejects a tx_hash already attached to a different action", async () => {
    const a = await svc.createAction(makeIntentInput({ idempotencyKey: "dup-a" }));
    const b = await svc.createAction(makeIntentInput({ idempotencyKey: "dup-b" }));
    await svc.attachTxHash(a.id, "tx_shared");
    await expect(svc.attachTxHash(b.id, "tx_shared"))
      .rejects.toMatchObject({ code: "TX_HASH_ALREADY_ATTACHED" });

    // The losing action stays pending; no duplicate tx-hash record is created.
    const bRow = await svc.getAction(b.id);
    expect(bRow?.status).toBe("pending");
    expect(bRow?.txHash).toBeNull();
  });
});

describe("LedgerService.cancelAction", () => {
  let db: TestDb;
  let svc: LedgerService;

  beforeAll(async () => { db = await startTestDb(); svc = new LedgerService(db.prisma); });
  afterAll(async () => { await db.stop(); });
  beforeEach(async () => { await resetDb(db.prisma); });

  it("transitions pending -> failed", async () => {
    const created = await svc.createAction(makeIntentInput());
    const cancelled = await svc.cancelAction(created.id, "WALLET_REJECTED", "user closed modal");
    expect(cancelled.status).toBe("failed");
    expect(cancelled.errorCode).toBe("WALLET_REJECTED");
    expect(cancelled.errorDetail).toBe("user closed modal");
  });

  it("is idempotent when already cancelled with USER_CANCELLED", async () => {
    const created = await svc.createAction(makeIntentInput());
    const first = await svc.cancelAction(created.id, "USER_CANCELLED", "user cancelled");
    expect(first.status).toBe("failed");
    expect(first.errorCode).toBe("USER_CANCELLED");

    const second = await svc.cancelAction(created.id, "USER_CANCELLED", "user cancelled again");
    expect(second.id).toBe(first.id);
    expect(second.status).toBe("failed");
    expect(second.errorCode).toBe("USER_CANCELLED");
  });

  it.each(["submitted", "confirmed", "reverted"] as const)(
    "does not overwrite a %s transition committed before its write",
    async (status) => {
      const created = await svc.createAction(makeIntentInput());
      const settledAt = new Date("2026-01-01T00:00:00.000Z");
      let competingCommit = false;
      // Scope scheduling to a separate real Prisma client extension. Mutating
      // the generated delegate with spies can corrupt its proxy on restoration.
      const racingPrisma = db.prisma.$extends({
        query: {
          actionLedger: {
            async $allOperations({ operation, args, query }) {
              if (!competingCommit && (operation === "update" || operation === "updateMany")) {
                competingCommit = true;
                await db.prisma.actionLedger.update({
                  where: { id: created.id },
                  data: {
                    status,
                    txHash: "concurrent-tx",
                    submittedAt: settledAt,
                    confirmedAt: status === "submitted" ? null : settledAt,
                    errorCode: status === "reverted" ? "REVERTED_ON_CHAIN" : null,
                  },
                });
              }
              return query(args);
            },
          },
        },
      });
      const racingService = new LedgerService(racingPrisma as unknown as typeof db.prisma);
      await expect(racingService.cancelAction(created.id, "USER_CANCELLED", "late cancel"))
        .rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
      expect(competingCommit).toBe(true);
      const row = await svc.getAction(created.id);
      expect(row?.status).toBe(status);
      expect(row?.txHash).toBe("concurrent-tx");
      expect(row?.submittedAt).toEqual(settledAt);
      expect(row?.confirmedAt).toEqual(status === "submitted" ? null : settledAt);
      expect(row?.errorCode).toBe(status === "reverted" ? "REVERTED_ON_CHAIN" : null);
      expect(row?.errorDetail).toBeNull();
    },
  );

  it("keeps the first cancellation reason when two callers cancel concurrently", async () => {
    const created = await svc.createAction(makeIntentInput());
    const results = await Promise.all([
      svc.cancelAction(created.id, "USER_CANCELLED", "first request"),
      svc.cancelAction(created.id, "CANCELLED_BY_USER", "second request"),
    ]);
    const stored = await svc.getAction(created.id);
    expect(stored?.status).toBe("failed");
    for (const result of results) {
      expect(result.errorCode).toBe(stored?.errorCode);
      expect(result.errorDetail).toBe(stored?.errorDetail);
    }
  });

  it("returns NOT_FOUND for a missing cancellation target", async () => {
    await expect(svc.cancelAction("11111111-1111-1111-1111-111111111111", "USER_CANCELLED"))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects cancel on submitted", async () => {
    const created = await svc.createAction(makeIntentInput());
    await svc.attachTxHash(created.id, "tx_1");
    await expect(svc.cancelAction(created.id, "WALLET_REJECTED"))
      .rejects.toMatchObject({ code: "ILLEGAL_TRANSITION" });
  });
});

describe("LedgerService.getAction + listActions", () => {
  let db: TestDb;
  let svc: LedgerService;

  beforeAll(async () => { db = await startTestDb(); svc = new LedgerService(db.prisma); });
  afterAll(async () => { await db.stop(); });
  beforeEach(async () => { await resetDb(db.prisma); });

  it("gets action by id", async () => {
    const created = await svc.createAction(makeIntentInput());
    const found = await svc.getAction(created.id);
    expect(found?.id).toBe(created.id);
  });

  it("returns null on missing id", async () => {
    const found = await svc.getAction("11111111-1111-1111-1111-111111111111");
    expect(found).toBeNull();
  });

  it("lists actions by wallet in desc order", async () => {
    const w = "GWALLET1";
    const a = await svc.createAction(makeIntentInput({ walletAddress: w, idempotencyKey: "k1" }));
    await new Promise((r) => setTimeout(r, 5));
    const b = await svc.createAction(makeIntentInput({ walletAddress: w, idempotencyKey: "k2" }));
    const list = await svc.listActions({ walletAddress: w, limit: 10 });
    expect(list.items.map((i) => i.id)).toEqual([b.id, a.id]);
    expect(list.nextCursor).toBeNull();
  });

  it("filters list by status", async () => {
    const w = "GWALLET2";
    const a = await svc.createAction(makeIntentInput({ walletAddress: w, idempotencyKey: "k3" }));
    await svc.createAction(makeIntentInput({ walletAddress: w, idempotencyKey: "k4" }));
    await svc.cancelAction(a.id, "WALLET_REJECTED");
    const list = await svc.listActions({ walletAddress: w, status: "failed", limit: 10 });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.status).toBe("failed");
  });

  it("paginates with cursor", async () => {
    const w = "GWALLET3";
    for (let i = 0; i < 3; i++) {
      await svc.createAction(makeIntentInput({ walletAddress: w, idempotencyKey: `p${i}` }));
      await new Promise((r) => setTimeout(r, 5));
    }
    const first = await svc.listActions({ walletAddress: w, limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await svc.listActions({ walletAddress: w, limit: 2, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });
});

describe("LedgerService.reconcileEvent", () => {
  let db: TestDb;
  let svc: LedgerService;

  beforeAll(async () => { db = await startTestDb(); svc = new LedgerService(db.prisma); });
  afterAll(async () => { await db.stop(); });
  beforeEach(async () => { await resetDb(db.prisma); });

  it("confirms a submitted action", async () => {
    const created = await svc.createAction(makeIntentInput());
    await svc.attachTxHash(created.id, "tx_confirm_1");
    const result = await svc.reconcileEvent({
      txHash: "tx_confirm_1",
      sorobanEventId: "evt_1",
      eventPayload: { amount: "100" },
      statusHint: "confirmed"
    });
    expect(result.matched).toBe(true);
    const row = await svc.getAction(created.id);
    expect(row?.status).toBe("confirmed");
    expect(row?.sorobanEventId).toBe("evt_1");
    expect(row?.confirmedAt).not.toBeNull();
  });

  it("marks reverted on revert hint", async () => {
    const created = await svc.createAction(makeIntentInput());
    await svc.attachTxHash(created.id, "tx_rev_1");
    await svc.reconcileEvent({
      txHash: "tx_rev_1",
      sorobanEventId: "evt_r",
      eventPayload: { reason: "oops" },
      statusHint: "reverted"
    });
    const row = await svc.getAction(created.id);
    expect(row?.status).toBe("reverted");
    expect(row?.errorCode).toBe("REVERTED_ON_CHAIN");
  });

  it("parks event when no matching ledger row exists", async () => {
    const result = await svc.reconcileEvent({
      txHash: "tx_orphan_event",
      sorobanEventId: "evt_parked",
      eventPayload: { ok: true },
      statusHint: "confirmed"
    });
    expect(result.matched).toBe(false);
    const parked = await db.prisma.pendingEvent.findUnique({ where: { txHash: "tx_orphan_event" } });
    expect(parked).not.toBeNull();
  });

  it("is idempotent on duplicate event delivery", async () => {
    const created = await svc.createAction(makeIntentInput());
    await svc.attachTxHash(created.id, "tx_dup");
    const first = await svc.reconcileEvent({
      txHash: "tx_dup", sorobanEventId: "evt_dup", eventPayload: {}, statusHint: "confirmed"
    });
    const second = await svc.reconcileEvent({
      txHash: "tx_dup", sorobanEventId: "evt_dup", eventPayload: {}, statusHint: "confirmed"
    });
    expect(first.matched).toBe(true);
    expect(second.matched).toBe(true);
    const row = await svc.getAction(created.id);
    expect(row?.status).toBe("confirmed");
  });
});

describe("LedgerService.scrubWallet", () => {
  let db: TestDb;
  let svc: LedgerService;

  beforeAll(async () => { db = await startTestDb(); svc = new LedgerService(db.prisma); });
  afterAll(async () => { await db.stop(); });
  beforeEach(async () => { await resetDb(db.prisma); });

  it("nulls action_payload and sets redacted_at for a wallet", async () => {
    const w = "GREDACT";
    const a = await svc.createAction(makeIntentInput({ walletAddress: w, idempotencyKey: "r1" }));
    const other = await svc.createAction(makeIntentInput({ walletAddress: "GOTHER", idempotencyKey: "r2" }));

    const result = await svc.scrubWallet(w);
    expect(result.scrubbed).toBe(1);

    const scrubbed = await db.prisma.actionLedger.findUnique({ where: { id: a.id } });
    expect(scrubbed?.actionPayload).toBeNull();
    expect(scrubbed?.redactedAt).not.toBeNull();

    const untouched = await db.prisma.actionLedger.findUnique({ where: { id: other.id } });
    expect(untouched?.actionPayload).not.toBeNull();
    expect(untouched?.redactedAt).toBeNull();
  });
});
