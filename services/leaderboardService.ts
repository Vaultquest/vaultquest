/**
 * Leaderboard Service (#8)
 *
 * Orchestration & Data access layer for Vault Leaderboard rankings.
 * Integrates with backend indexed action ledger data and provides privacy-conscious address formatting.
 */

import { LeaderboardEntry, LeaderboardFilterOptions, LeaderboardResponse } from "@/types/leaderboard";

/**
 * Privacy-conscious address formatting.
 * Formats Stellar addresses (e.g. GABCD...XYZ9) or EVM addresses (e.g. 0x1234...5678).
 */
export function formatPrivacyAddress(address?: string | null): string {
  if (!address || typeof address !== "string") {
    return "Anonymous Saver";
  }
  const clean = address.trim();
  if (clean.length <= 10) {
    return clean;
  }
  return `${clean.slice(0, 4)}...${clean.slice(-4)}`;
}

/**
 * Deterministic mock leaderboard data for local development when live backend is offline.
 */
const DEMO_LEADERBOARD_ENTRIES: LeaderboardEntry[] = [
  {
    rank: 1,
    previousRank: 2,
    walletAddress: "GABCD1234567890STUVWXWXYZ1234567890ALPHA",
    displayName: formatPrivacyAddress("GABCD1234567890STUVWXWXYZ1234567890ALPHA"),
    vaultId: "v_usdc_stable",
    vaultName: "USDC Savings Sprint",
    depositedAmount: 12500,
    asset: "USDC",
    ticketsCount: 250,
    prizeWins: 3,
    score: 9840,
    state: "rising",
    lastActivity: "10 minutes ago",
  },
  {
    rank: 2,
    previousRank: 1,
    walletAddress: "GBBDU9876543210ZYXWVUTSRQPONMLKJIHGBETA",
    displayName: formatPrivacyAddress("GBBDU9876543210ZYXWVUTSRQPONMLKJIHGBETA"),
    vaultId: "v_xlm_drip",
    vaultName: "XLM Drip Vault",
    depositedAmount: 8200,
    asset: "XLM",
    ticketsCount: 164,
    prizeWins: 1,
    score: 8120,
    state: "holding",
    lastActivity: "1 hour ago",
  },
  {
    rank: 3,
    previousRank: 5,
    walletAddress: "GC4AK9Q2345678901234567890123456789GAMMA",
    displayName: formatPrivacyAddress("GC4AK9Q2345678901234567890123456789GAMMA"),
    vaultId: "v_student_quest",
    vaultName: "Student Saver Quest",
    depositedAmount: 3400,
    asset: "USDC",
    ticketsCount: 68,
    prizeWins: 2,
    score: 6540,
    state: "rising",
    lastActivity: "3 hours ago",
  },
  {
    rank: 4,
    previousRank: 4,
    walletAddress: "GAT5F92A1234567890123456789012345678DELTA",
    displayName: formatPrivacyAddress("GAT5F92A1234567890123456789012345678DELTA"),
    vaultId: "v_usdc_stable",
    vaultName: "USDC Savings Sprint",
    depositedAmount: 2100,
    asset: "USDC",
    ticketsCount: 42,
    prizeWins: 0,
    score: 4200,
    state: "holding",
    lastActivity: "1 day ago",
  },
  {
    rank: 5,
    previousRank: 0,
    walletAddress: "GDBKW4XP000011112222333344445555666EPSILON",
    displayName: formatPrivacyAddress("GDBKW4XP000011112222333344445555666EPSILON"),
    vaultId: "v_xlm_drip",
    vaultName: "XLM Drip Vault",
    depositedAmount: 950,
    asset: "XLM",
    ticketsCount: 19,
    prizeWins: 0,
    score: 1900,
    state: "new",
    lastActivity: "2 days ago",
  },
];

/**
 * Sorts leaderboard entries deterministically by score (desc), then depositedAmount (desc), then ticketsCount (desc).
 */
export function sortLeaderboardEntries(entries: LeaderboardEntry[]): LeaderboardEntry[] {
  return [...entries].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.depositedAmount !== a.depositedAmount) return b.depositedAmount - a.depositedAmount;
    return b.ticketsCount - a.ticketsCount;
  });
}

/**
 * Fetches indexed leaderboard rankings from the backend API or falls back to demo data in local dev mode.
 */
export async function getLeaderboardData(
  options: LeaderboardFilterOptions = {}
): Promise<LeaderboardResponse> {
  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";
  const endpoint = `${backendUrl}/actions/leaderboard${options.vaultId ? `?vaultId=${encodeURIComponent(options.vaultId)}` : ""}`;

  try {
    const res = await fetch(endpoint, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(3000),
    });

    if (res.ok) {
      const json = await res.json();
      if (json && Array.isArray(json.data)) {
        const sorted = sortLeaderboardEntries(json.data);
        return {
          success: true,
          data: sorted,
          total: sorted.length,
          updatedAt: new Date().toISOString(),
          source: "indexed",
        };
      }
    }
  } catch (_err) {
    // Graceful fallback to deterministic local dev data on connection failure
  }

  let filtered = DEMO_LEADERBOARD_ENTRIES;
  if (options.vaultId) {
    filtered = filtered.filter((e) => e.vaultId === options.vaultId);
  }

  const sorted = sortLeaderboardEntries(filtered);
  return {
    success: true,
    data: sorted,
    total: sorted.length,
    updatedAt: new Date().toISOString(),
    source: "demo",
  };
}
