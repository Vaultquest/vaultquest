"use client";

import { useState, useEffect, useCallback } from "react";
import { Award, Info, Minus, TrendingUp, UserPlus, AlertCircle, RefreshCw, Ticket, Trophy } from "lucide-react";
import { getLeaderboardData, formatPrivacyAddress } from "@/services/leaderboardService";

const STATE_STYLES = {
  rising: {
    label: "Rising",
    icon: TrendingUp,
    className: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
  },
  holding: {
    label: "Holding",
    icon: Minus,
    className: "text-slate-600 dark:text-slate-400 bg-slate-500/10 border-slate-500/20",
  },
  new: {
    label: "New",
    icon: UserPlus,
    className: "text-blue-600 dark:text-blue-400 bg-blue-500/10 border-blue-500/20",
  },
};

function LeaderboardSkeleton() {
  return (
    <div className="mt-5 space-y-3 animate-pulse" data-testid="leaderboard-skeleton">
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className="grid gap-3 rounded-xl border border-vault-border bg-vault-surface/40 p-4 sm:grid-cols-[auto_1fr_auto]"
        >
          <div className="h-10 w-10 rounded-full bg-vault-border/40" />
          <div className="space-y-2">
            <div className="h-5 w-36 rounded bg-vault-border/40" />
            <div className="h-4 w-52 rounded bg-vault-border/20" />
          </div>
          <div className="h-6 w-20 rounded bg-vault-border/30 sm:ml-auto" />
        </div>
      ))}
    </div>
  );
}

export function VaultLeaderboard({ vaultId, limit, initialData, onRetry }) {
  const [data, setData] = useState(initialData || []);
  const [isLoading, setIsLoading] = useState(!initialData);
  const [error, setError] = useState(null);
  const [dataSource, setDataSource] = useState("indexed");

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await getLeaderboardData({ vaultId, limit });
      if (res.success) {
        setData(res.data);
        setDataSource(res.source);
      } else {
        setError("Failed to load leaderboard data.");
      }
    } catch (_err) {
      setError("Unable to connect to indexed leaderboard service.");
    } finally {
      setIsLoading(false);
    }
  }, [vaultId, limit]);

  useEffect(() => {
    if (!initialData) {
      loadData();
    }
  }, [loadData, initialData]);

  const handleRetry = () => {
    onRetry?.();
    loadData();
  };

  return (
    <section className="vq-glass p-4 sm:p-6" aria-labelledby="vault-leaderboard-title" data-testid="vault-leaderboard">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-vault-border bg-vault-surface text-amber-500 shadow-sm">
            <Award className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h2 id="vault-leaderboard-title" className="text-lg font-bold text-vault-text">
              Saver Leaderboard
            </h2>
            <p className="mt-1 text-sm text-vault-muted">
              Live indexed rankings based on deposit consistency, ticket entries, and yield activity.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 self-start">
          <span
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${
              dataSource === "indexed"
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
            }`}
          >
            {dataSource === "indexed" ? "Live indexed data" : "Demo data"}
          </span>
        </div>
      </div>

      {isLoading ? (
        <LeaderboardSkeleton />
      ) : error ? (
        <div
          className="mt-5 flex flex-col items-center rounded-xl border border-red-500/20 bg-red-500/5 p-6 text-center"
          data-testid="leaderboard-error"
        >
          <AlertCircle className="h-8 w-8 text-red-500" aria-hidden="true" />
          <h3 className="mt-2 text-base font-semibold text-vault-text">Leaderboard Unavailable</h3>
          <p className="mt-1 text-sm text-vault-muted">{error}</p>
          <button
            type="button"
            onClick={handleRetry}
            className="mt-4 inline-flex items-center gap-2 rounded-lg border border-vault-border bg-vault-surface px-4 py-2 text-sm font-semibold text-vault-text hover:bg-vault-border/20"
          >
            <RefreshCw className="h-4 w-4" />
            Retry
          </button>
        </div>
      ) : data.length === 0 ? (
        <div
          className="mt-5 flex flex-col items-center rounded-xl border border-dashed border-vault-border bg-vault-surface/30 px-4 py-10 text-center"
          data-testid="leaderboard-empty"
        >
          <Info className="h-8 w-8 text-vault-muted" aria-hidden="true" />
          <h3 className="mt-3 text-base font-semibold text-vault-text">No leaderboard activity yet</h3>
          <p className="mt-1 max-w-md text-sm text-vault-muted">
            Be the first saver to deposit into this vault and claim the top ranking spot!
          </p>
        </div>
      ) : (
        <div className="mt-5 space-y-3" data-testid="leaderboard-list">
          {data.map((ranking) => {
            const state = STATE_STYLES[ranking.state] || STATE_STYLES.holding;
            const Icon = state.icon;
            const rankFormatted = `#${ranking.rank}`;
            const addressFormatted = ranking.displayName || formatPrivacyAddress(ranking.walletAddress);

            return (
              <div
                key={`${ranking.rank}-${ranking.walletAddress || ranking.displayName}`}
                className="grid gap-3 rounded-xl border border-vault-border bg-vault-surface/40 p-4 transition-all duration-200 hover:border-vault-border/80 sm:grid-cols-[auto_1fr_auto]"
                data-testid={`leaderboard-item-${ranking.rank}`}
              >
                <div
                  className={`flex h-10 w-10 items-center justify-center rounded-full border text-sm font-black ${
                    ranking.rank === 1
                      ? "border-amber-500/50 bg-amber-500/20 text-amber-500"
                      : ranking.rank === 2
                      ? "border-slate-400/50 bg-slate-400/20 text-slate-300"
                      : ranking.rank === 3
                      ? "border-amber-700/50 bg-amber-700/20 text-amber-600"
                      : "border-vault-border bg-vault-bg text-vault-text"
                  }`}
                >
                  {rankFormatted}
                </div>

                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-vault-text" data-testid="saver-address">
                      {addressFormatted}
                    </p>
                    <span
                      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-semibold ${state.className}`}
                    >
                      <Icon className="h-3 w-3" aria-hidden="true" />
                      {state.label}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-vault-muted">
                    <span>{ranking.vaultName}</span>
                    <span>•</span>
                    <span className="inline-flex items-center gap-1">
                      <Ticket className="h-3 w-3 text-amber-500" />
                      {ranking.ticketsCount} tickets
                    </span>
                    {ranking.prizeWins > 0 && (
                      <>
                        <span>•</span>
                        <span className="inline-flex items-center gap-1 text-amber-500 font-medium">
                          <Trophy className="h-3 w-3" />
                          {ranking.prizeWins} wins
                        </span>
                      </>
                    )}
                    <span>•</span>
                    <span>{ranking.lastActivity}</span>
                  </div>
                </div>

                <div className="text-left sm:text-right">
                  <p className="font-bold text-vault-text" data-testid="saver-score">
                    {ranking.score.toLocaleString()} pts
                  </p>
                  <p className="text-xs text-vault-muted">
                    {ranking.depositedAmount.toLocaleString()} {ranking.asset}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default function VaultLeaderboardPlaceholder({ rankings, vaultId, limit }) {
  return <VaultLeaderboard vaultId={vaultId} limit={limit} initialData={rankings} />;
}
