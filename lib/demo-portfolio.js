/** Demo metrics shown when a wallet is connected (until live indexer data is wired). */
export const DEMO_PORTFOLIO = {
  activeDeposits: 4250.0,
  cumulativeWinnings: 312.5,
  apyPercent: 8.5,
  accruedYieldBase: 127.84,
};

/**
 * Realistic local activity history used to drive the dashboard, account, and
 * activity flows until live wallet transactions are wired in. It deliberately
 * spans every lifecycle event (deposits, prize draws/wins, rewards, and
 * withdrawals) across multiple pool states, plus a failed transaction so the
 * failed/cancelled status path is represented in local demos and tests.
 */
export const DEMO_TRANSACTIONS = [
  // Community Drip Pool — active round
  { id: "tx-1", type: "deposit", pool: "Community Drip Pool", asset: "USDC", amount: 500, date: "2026-05-28T14:22:00Z", status: "confirmed" },
  { id: "tx-2", type: "reward", pool: "Community Drip Pool", asset: "USDC", amount: 42.5, date: "2026-05-20T09:00:00Z", status: "confirmed" },
  { id: "tx-5", type: "deposit", pool: "Community Drip Pool", asset: "USDC", amount: 1000, date: "2026-05-01T08:15:00Z", status: "confirmed" },
  { id: "tx-8", type: "deposit", pool: "Community Drip Pool", asset: "USDC", amount: 300, date: "2026-04-05T10:20:00Z", status: "pending" },
  { id: "tx-12", type: "withdraw", pool: "Community Drip Pool", asset: "USDC", amount: 250, date: "2026-06-02T16:40:00Z", status: "confirmed" },
  // Starter Vault — completed round, mixed claim history
  { id: "tx-3", type: "deposit", pool: "Starter Vault", asset: "AVAX", amount: 250, date: "2026-05-15T18:45:00Z", status: "confirmed" },
  { id: "tx-4", type: "withdraw", pool: "Starter Vault", asset: "AVAX", amount: 100, date: "2026-05-10T11:30:00Z", status: "confirmed" },
  { id: "tx-9", type: "reward", pool: "Starter Vault", asset: "AVAX", amount: 18.2, date: "2026-05-11T09:00:00Z", status: "confirmed" },
  // High-Yield Round — active draw pool
  { id: "tx-6", type: "deposit", pool: "High-Yield Round", asset: "XLM", amount: 750, date: "2026-04-22T16:00:00Z", status: "confirmed" },
  { id: "tx-7", type: "reward", pool: "High-Yield Round", asset: "XLM", amount: 270, date: "2026-04-18T12:00:00Z", status: "confirmed" },
  { id: "tx-10", type: "deposit", pool: "High-Yield Round", asset: "XLM", amount: 400, date: "2026-06-03T13:10:00Z", status: "confirmed" },
  // Paused Drip Pool — round temporarily frozen
  { id: "tx-11", type: "deposit", pool: "Paused Drip Pool", asset: "AQUA", amount: 1200, date: "2026-06-04T19:05:00Z", status: "confirmed" },
  // Failed Meme Pool — round failed, deposit attempt declined
  { id: "tx-13", type: "deposit", pool: "Meme Momentum Shorts", asset: "USDC", amount: 200, date: "2026-06-05T08:30:00Z", status: "failed" },
];

export const PUBLIC_STATS = {
  tvl: 2_847_500,
  prizePool: 142_375,
  activeSavers: 3842,
  currentRound: 47,
  prizeEstimate: 14_237,
  recentActivityCount: 28,
};

/**
 * Aggregates raw activity into a per-vault position summary: how many
 * vaults the user has joined, their balance in each, and any transactions
 * still awaiting confirmation.
 * @param {typeof DEMO_TRANSACTIONS} transactions
 */
export function summarizeAccountPositions(transactions = DEMO_TRANSACTIONS) {
  const byPool = new Map();

  for (const tx of transactions) {
    const entry = byPool.get(tx.pool) ?? {
      pool: tx.pool,
      asset: tx.asset,
      balance: 0,
      pendingCount: 0,
    };

    if (tx.status === "failed" || tx.status === "reverted") {
      // A failed/reverted action never landed on-chain; it contributes neither
      // to the balance nor to the pending count.
      continue;
    }

    if (tx.type === "deposit" || tx.type === "reward") {
      entry.balance += tx.amount;
    } else if (tx.type === "withdraw") {
      entry.balance -= tx.amount;
    }

    if (tx.status === "pending") {
      entry.pendingCount += 1;
    }

    byPool.set(tx.pool, entry);
  }

  const positions = Array.from(byPool.values());

  return {
    positions,
    totalJoinedVaults: positions.length,
    totalBalance: positions.reduce((sum, position) => sum + position.balance, 0),
    pendingActionsCount: positions.reduce((sum, position) => sum + position.pendingCount, 0),
  };
}
