/**
 * Leaderboard Domain Models & Data Contracts (#8)
 */

export type RankState = "rising" | "holding" | "new";

export interface LeaderboardEntry {
  rank: number;
  previousRank: number;
  walletAddress: string;
  displayName: string;
  vaultId: string;
  vaultName: string;
  depositedAmount: number;
  asset: string;
  ticketsCount: number;
  prizeWins: number;
  score: number;
  state: RankState;
  lastActivity: string;
}

export interface LeaderboardFilterOptions {
  vaultId?: string;
  timeframe?: "all" | "weekly" | "monthly";
  limit?: number;
}

export interface LeaderboardResponse {
  success: boolean;
  data: LeaderboardEntry[];
  total: number;
  updatedAt: string;
  source: "indexed" | "demo";
}
