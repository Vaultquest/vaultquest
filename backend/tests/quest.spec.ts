import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";
import { seedAction } from "./helpers/factory.js";
import { QuestService } from "../src/services/questService.js";
import { CANONICAL_DEPOSIT_ASSET } from "../src/constants.js";

const WALLET = "GQUESTWALLET000000000000000000000000000000000000000000";

/**
 * Builds a versioned, asset-aware deposit payload (issue #94) for the
 * canonical deposit asset. `dollars` must be an integer number of whole
 * units for these tests (the asset has 7 decimals).
 */
function depositPayload(dollars: number, extra: Record<string, unknown> = {}) {
  const amountMinor = BigInt(dollars) * 10n ** BigInt(CANONICAL_DEPOSIT_ASSET.decimals);
  return {
    payload_version: 1,
    asset_code: CANONICAL_DEPOSIT_ASSET.code,
    asset_issuer: CANONICAL_DEPOSIT_ASSET.issuer,
    decimals: CANONICAL_DEPOSIT_ASSET.decimals,
    amount_minor: amountMinor.toString(),
    ...extra
  };
}

describe("QuestService", () => {
  let db: TestDb;
  let svc: QuestService;

  beforeAll(async () => {
    db = await startTestDb();
    svc = new QuestService(db.prisma);
  });
  afterAll(async () => { await db.stop(); });
  beforeEach(async () => { await resetDb(db.prisma); });

  it("computes progress across the five standard quests", async () => {
    // Three deposits across two pools, $60 total, two distinct months.
    await seedAction(db.prisma, {
      walletAddress: WALLET, status: "confirmed",
      actionPayload: depositPayload(40, { vault_id: "pool-a" })
    });
    await seedAction(db.prisma, {
      walletAddress: WALLET, status: "confirmed",
      actionPayload: depositPayload(20, { vault_id: "pool-b" })
    });
    const winter = await seedAction(db.prisma, {
      walletAddress: WALLET, status: "confirmed",
      actionPayload: depositPayload(0, { pool_id: "pool-a" })
    });
    await db.prisma.actionLedger.update({
      where: { id: winter.id },
      data: { createdAt: new Date("2026-01-15T00:00:00Z") }
    });

    const progress = await svc.evaluateWallet(WALLET);
    const byId = new Map(progress.map((p) => [p.questId, p]));

    expect(byId.get("first_deposit")?.status).toBe("completed");
    expect(byId.get("save_100")?.progress).toBe(60);
    expect(byId.get("save_100")?.status).toBe("in_progress");
    expect(byId.get("save_100_three_months")?.progress).toBe(2);
    expect(byId.get("participate_5_draws")?.progress).toBe(2);
    expect(byId.get("first_win")?.status).toBe("in_progress");
  });

  it("ignores non-confirmed and redacted rows", async () => {
    await seedAction(db.prisma, {
      walletAddress: WALLET, status: "pending",
      actionPayload: depositPayload(1000, { vault_id: "p" })
    });
    const metrics = await svc.computeMetrics(WALLET);
    expect(metrics.totalDeposited).toBe(0);
    expect(metrics.depositCount).toBe(0);
  });

  it("quarantines legacy payloads without asset identity from the money metric (issue #94)", async () => {
    // Old-shape payload: a bare `amount` with no asset/decimals identity.
    // It must not be summed as if it were dollars, but it still counts
    // toward deposit-count/pool/month metrics that don't depend on value.
    await seedAction(db.prisma, {
      walletAddress: WALLET, status: "confirmed",
      actionPayload: { vault_id: "pool-legacy", amount: "9999" }
    });
    const metrics = await svc.computeMetrics(WALLET);
    expect(metrics.totalDeposited).toBe(0);
    expect(metrics.totalDepositedMinor).toBe(0n);
    expect(metrics.depositCount).toBe(1);
  });

  it("never sums a non-canonical asset into the fiat-target metric (issue #94)", async () => {
    await seedAction(db.prisma, {
      walletAddress: WALLET, status: "confirmed",
      actionPayload: depositPayload(500, {
        vault_id: "pool-xlm",
        asset_code: "XLM",
        asset_issuer: "native"
      })
    });
    const metrics = await svc.computeMetrics(WALLET);
    expect(metrics.totalDeposited).toBe(0);
    expect(metrics.totalDepositedMinor).toBe(0n);
  });

  it("marks a quest completed and stamps completedAt once", async () => {
    await seedAction(db.prisma, {
      walletAddress: WALLET, status: "confirmed",
      actionType: "claim", actionPayload: { vault_id: "p", amount: "5" }
    });
    const first = await svc.evaluateWallet(WALLET);
    const win = first.find((p) => p.questId === "first_win")!;
    expect(win.status).toBe("completed");
    expect(win.completedAt).toBeInstanceOf(Date);

    // Re-evaluating must not move the completion timestamp.
    const second = await svc.evaluateWallet(WALLET);
    const win2 = second.find((p) => p.questId === "first_win")!;
    expect(win2.completedAt?.getTime()).toBe(win.completedAt?.getTime());
  });

  it("evaluateRecent picks up wallets with fresh confirmed activity", async () => {
    await seedAction(db.prisma, {
      walletAddress: WALLET, status: "confirmed",
      actionPayload: depositPayload(150, { vault_id: "p" })
    });
    const result = await svc.evaluateRecent(new Date(Date.now() - 60_000));
    expect(result.wallets).toBe(1);

    const saved = await svc.getUserQuests(WALLET);
    expect(saved.find((q) => q.questId === "save_100")!.status).toBe("completed");
  });

  it("completes a per-wallet evaluation in under 100ms over a large ledger", async () => {
    // Seed a sizeable confirmed history for the wallet.
    const rows = Array.from({ length: 2000 }, (_, i) => ({
      idempotencyKey: randomUUID(),
      walletAddress: WALLET,
      actionType: "deposit" as const,
      actionPayload: { vault_id: `pool-${i % 7}`, amount: "1" },
      status: "confirmed" as const
    }));
    await db.prisma.actionLedger.createMany({ data: rows });

    // Warm the query plan, then measure.
    await svc.computeMetrics(WALLET);
    const start = performance.now();
    await svc.computeMetrics(WALLET);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(100);
  });

  it("returns stable results and does not double-apply state on duplicate evaluations", async () => {
    await seedAction(db.prisma, {
      walletAddress: WALLET, status: "confirmed",
      actionPayload: depositPayload(120, { vault_id: "pool-a" })
    });

    const firstEval = await svc.evaluateWallet(WALLET);
    const firstSave100 = firstEval.find((q) => q.questId === "save_100")!;
    expect(firstSave100.status).toBe("completed");
    expect(firstSave100.completedAt).toBeInstanceOf(Date);

    // Run duplicate evaluation
    const secondEval = await svc.evaluateWallet(WALLET);
    const secondSave100 = secondEval.find((q) => q.questId === "save_100")!;
    expect(secondSave100.status).toBe("completed");
    // Ensure completedAt timestamp did not change
    expect(secondSave100.completedAt?.getTime()).toBe(firstSave100.completedAt?.getTime());
  });

  it("handles partially completed operations when new actions are seeded incrementally", async () => {
    // Seed $60 deposit initially (partial progress for save_100)
    await seedAction(db.prisma, {
      walletAddress: WALLET, status: "confirmed",
      actionPayload: depositPayload(60, { vault_id: "pool-a" })
    });

    const firstEval = await svc.evaluateWallet(WALLET);
    const firstSave100 = firstEval.find((q) => q.questId === "save_100")!;
    expect(firstSave100.status).toBe("in_progress");
    expect(firstSave100.progress).toBe(60);
    expect(firstSave100.completedAt).toBeNull();

    // Sleep a tiny bit to ensure date difference if needed, but not strictly required

    // Seed remaining $40 deposit to complete save_100 quest
    await seedAction(db.prisma, {
      walletAddress: WALLET, status: "confirmed",
      actionPayload: depositPayload(40, { vault_id: "pool-a" })
    });

    const secondEval = await svc.evaluateWallet(WALLET);
    const secondSave100 = secondEval.find((q) => q.questId === "save_100")!;
    expect(secondSave100.status).toBe("completed");
    expect(secondSave100.progress).toBe(100);
    expect(secondSave100.completedAt).toBeInstanceOf(Date);
  });
});
