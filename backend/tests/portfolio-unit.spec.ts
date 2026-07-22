import { describe, it, expect } from "vitest";
import { LedgerService } from "../src/services/ledger.js";

describe("LedgerService.getPortfolioSummary Unit Tests (No Database Required)", () => {
  const walletAddress = "GABCDEF1234567890123456789012345678901234567890123456789";

  it("handles empty wallet cleanly (zero-state)", async () => {
    // Mock prisma actionLedger.findMany returning an empty list
    const mockPrisma = {
      actionLedger: {
        findMany: async (args: any) => {
          expect(args.where.walletAddress).toBe(walletAddress);
          return [];
        }
      },
      indexerCheckpoint: {
        findMany: async () => []
      }
    } as any;

    const svc = new LedgerService(mockPrisma);
    const summary = await svc.getPortfolioSummary(walletAddress);

    expect(summary.wallet_address).toBe(walletAddress);
    expect(summary.total_deposits).toBe(0);
    expect(summary.active_positions).toEqual([]);
    expect(summary.pending_rewards).toBe(0);
    expect(summary.claimable_amount).toBe(0);
    expect(summary.recent_activity).toEqual([]);
  });

  it("aggregates deposits, withdrawals, and claims accurately", async () => {
    const mockActions = [
      {
        id: "act-pending",
        walletAddress,
        actionType: "deposit",
        status: "pending",
        createdAt: new Date("2026-05-30T02:00:00Z"),
        txHash: null,
        actionPayload: { vault_id: "pool-A", amount: "500" }
      },
      {
        id: "act-claim",
        walletAddress,
        actionType: "claim",
        status: "confirmed",
        createdAt: new Date("2026-05-30T01:50:00Z"),
        txHash: "tx-claim",
        actionPayload: { vault_id: "pool-A", amount: "30" }
      },
      {
        id: "act-withdraw-1",
        walletAddress,
        actionType: "withdraw",
        status: "confirmed",
        createdAt: new Date("2026-05-30T01:40:00Z"),
        txHash: "tx-wd1",
        actionPayload: { vault_id: "pool-A", amount: "50" }
      },
      {
        id: "act-deposit-2",
        walletAddress,
        actionType: "deposit",
        status: "confirmed",
        createdAt: new Date("2026-05-30T01:30:00Z"),
        txHash: "tx-dep2",
        actionPayload: { vault_id: "pool-B", amount: "400" }
      },
      {
        id: "act-deposit-1",
        walletAddress,
        actionType: "deposit",
        status: "confirmed",
        createdAt: new Date("2026-05-30T01:20:00Z"),
        txHash: "tx-dep1",
        actionPayload: { vault_id: "pool-A", amount: "200" }
      }
    ];

    const mockPrisma = {
      actionLedger: {
        findMany: async (args: any) => {
          expect(args.where.walletAddress).toBe(walletAddress);
          return mockActions;
        }
      },
      indexerCheckpoint: {
        findMany: async () => []
      }
    } as any;

    const svc = new LedgerService(mockPrisma);
    const summary = await svc.getPortfolioSummary(walletAddress);

    expect(summary.wallet_address).toBe(walletAddress);
    expect(summary.total_deposits).toBe(550); // pool-A (200 - 50 = 150) + pool-B (400) = 550
    expect(summary.claimable_amount).toBe(30);
    expect(summary.pending_rewards).toBe(0);

    // Verify active positions
    expect(summary.active_positions).toHaveLength(2);
    const posA = summary.active_positions.find(p => p.vault_id === "pool-A");
    const posB = summary.active_positions.find(p => p.vault_id === "pool-B");
    expect(posA?.balance).toBe(150);
    expect(posB?.balance).toBe(400);

    // Verify recent activity is limited and properly ordered
    expect(summary.recent_activity).toHaveLength(5);
    expect(summary.recent_activity[0]?.id).toBe("act-pending");
    expect(summary.recent_activity[0]?.status).toBe("pending");
    expect(summary.recent_activity[4]?.id).toBe("act-deposit-1");
  });

  it("handles a stale global indexer checkpoint correctly", async () => {
    const mockActions = [
      {
        id: "act-1",
        walletAddress,
        actionType: "deposit",
        status: "confirmed",
        createdAt: new Date("2026-05-30T01:00:00Z"),
        txHash: "tx-1",
        actionPayload: { vault_id: "pool-A", amount: "100" }
      }
    ];

    const mockPrisma = {
      actionLedger: {
        findMany: async () => mockActions
      },
      indexerCheckpoint: {
        findMany: async (args: any) => {
          expect(args.where.id.in).toContain("singleton");
          expect(args.where.id.in).toContain("vault-pool-A");
          return [
            {
              id: "singleton",
              latestLedger: 100,
              lastProcessedEventId: "1",
              lastSyncTime: new Date("2026-05-30T00:00:00Z"),
              lastError: null,
              lastSuccessSyncTime: new Date("2026-05-30T00:00:00Z") // 1 hour ago
            }
          ];
        }
      }
    } as any;

    const svc = new LedgerService(mockPrisma);
    const now = new Date("2026-05-30T01:00:00Z"); // 1 hour elapsed
    const summary = await svc.getPortfolioSummary(walletAddress, {
      staleAfterMs: 5 * 60 * 1000, // 5 minutes stale threshold
      now
    });

    expect(summary.total_deposits).toBe(0);
    expect(summary.total_stale_deposits).toBe(100);
    expect(summary.is_stale).toBe(true);
    expect(summary.active_positions).toHaveLength(1);
    expect(summary.active_positions[0].is_stale).toBe(true);
    expect(summary.active_positions[0].last_updated_at).toEqual(new Date("2026-05-30T00:00:00Z"));
  });

  it("handles mixed stale and fresh vaults based on vault-specific checkpoints", async () => {
    const mockActions = [
      {
        id: "act-1",
        walletAddress,
        actionType: "deposit",
        status: "confirmed",
        createdAt: new Date("2026-05-30T01:00:00Z"),
        txHash: "tx-1",
        actionPayload: { vault_id: "pool-fresh", amount: "150" }
      },
      {
        id: "act-2",
        walletAddress,
        actionType: "deposit",
        status: "confirmed",
        createdAt: new Date("2026-05-30T01:00:00Z"),
        txHash: "tx-2",
        actionPayload: { vault_id: "pool-stale", amount: "300" }
      }
    ];

    const mockPrisma = {
      actionLedger: {
        findMany: async () => mockActions
      },
      indexerCheckpoint: {
        findMany: async () => {
          return [
            {
              id: "singleton",
              latestLedger: 100,
              lastProcessedEventId: "1",
              lastSyncTime: new Date("2026-05-30T00:58:00Z"),
              lastSuccessSyncTime: new Date("2026-05-30T00:58:00Z")
            },
            {
              id: "vault-pool-fresh",
              latestLedger: 100,
              lastProcessedEventId: "1",
              lastSyncTime: new Date("2026-05-30T00:59:00Z"),
              lastSuccessSyncTime: new Date("2026-05-30T00:59:00Z") // 1 min ago -> fresh
            },
            {
              id: "vault-pool-stale",
              latestLedger: 90,
              lastProcessedEventId: "0",
              lastSyncTime: new Date("2026-05-30T00:40:00Z"),
              lastSuccessSyncTime: new Date("2026-05-30T00:40:00Z") // 20 mins ago -> stale
            }
          ];
        }
      }
    } as any;

    const svc = new LedgerService(mockPrisma);
    const now = new Date("2026-05-30T01:00:00Z");
    const summary = await svc.getPortfolioSummary(walletAddress, {
      staleAfterMs: 5 * 60 * 1000,
      now
    });

    expect(summary.total_deposits).toBe(150);
    expect(summary.total_stale_deposits).toBe(300);
    expect(summary.is_stale).toBe(true);

    const freshPos = summary.active_positions.find(p => p.vault_id === "pool-fresh");
    const stalePos = summary.active_positions.find(p => p.vault_id === "pool-stale");

    expect(freshPos?.is_stale).toBe(false);
    expect(freshPos?.last_updated_at).toEqual(new Date("2026-05-30T00:59:00Z"));
    expect(stalePos?.is_stale).toBe(true);
    expect(stalePos?.last_updated_at).toEqual(new Date("2026-05-30T00:40:00Z"));
  });
});
