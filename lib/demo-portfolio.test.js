import { describe, it, expect } from "vitest";
import { summarizeAccountPositions, DEMO_TRANSACTIONS } from "@/lib/demo-portfolio";

describe("summarizeAccountPositions", () => {
  it("returns an empty summary for no activity", () => {
    const summary = summarizeAccountPositions([]);
    expect(summary).toEqual({
      positions: [],
      totalJoinedVaults: 0,
      totalBalance: 0,
      pendingActionsCount: 0,
    });
  });

  it("aggregates balance per pool from deposits, rewards, and withdrawals", () => {
    const summary = summarizeAccountPositions([
      { id: "1", type: "deposit", pool: "Starter Vault", asset: "USDC", amount: 500, status: "confirmed" },
      { id: "2", type: "reward", pool: "Starter Vault", asset: "USDC", amount: 50, status: "confirmed" },
      { id: "3", type: "withdraw", pool: "Starter Vault", asset: "USDC", amount: 100, status: "confirmed" },
      { id: "4", type: "deposit", pool: "High-Yield Round", asset: "XLM", amount: 200, status: "pending" },
    ]);

    expect(summary.totalJoinedVaults).toBe(2);
    expect(summary.totalBalance).toBe(650);
    expect(summary.pendingActionsCount).toBe(1);

    const starter = summary.positions.find((p) => p.pool === "Starter Vault");
    expect(starter.balance).toBe(450);
    expect(starter.pendingCount).toBe(0);

    const highYield = summary.positions.find((p) => p.pool === "High-Yield Round");
    expect(highYield.balance).toBe(200);
    expect(highYield.pendingCount).toBe(1);
  });
});

describe("DEMO_TRANSACTIONS", () => {
  it("covers deposits, rewards (draw wins), and withdrawals across round states", () => {
    const types = new Set(DEMO_TRANSACTIONS.map((tx) => tx.type));
    expect(types).toEqual(new Set(["deposit", "reward", "withdraw"]));

    const statuses = new Set(DEMO_TRANSACTIONS.map((tx) => tx.status));
    expect(statuses).toEqual(new Set(["confirmed", "pending", "failed"]));
  });

  it("is idempotent: summarizing the same immutable history is stable", () => {
    const first = summarizeAccountPositions(DEMO_TRANSACTIONS);
    const second = summarizeAccountPositions(DEMO_TRANSACTIONS);
    expect(second).toEqual(first);
  });

  it("treats failed/reverted transactions as never-arriving (no balance, no pending)", () => {
    const summary = summarizeAccountPositions([
      { id: "f", type: "deposit", pool: "Meme Momentum Shorts", asset: "USDC", amount: 200, status: "failed" },
      { id: "r", type: "withdraw", pool: "Meme Momentum Shorts", asset: "USDC", amount: 50, status: "reverted" },
    ]);
    const position = summary.positions.find((p) => p.pool === "Meme Momentum Shorts");
    expect(position.balance).toBe(0);
    expect(position.pendingCount).toBe(0);
    expect(summary.totalBalance).toBe(0);
    expect(summary.pendingActionsCount).toBe(0);
  });
});

