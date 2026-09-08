import type { FC } from "react";
import { useState } from "react";
import { Clock, CheckCircle2, AlertCircle, XCircle, ArrowRight, Loader2 } from "lucide-react";
import type { DelayedWithdrawalRequest } from "../contract/types";
import { formatAmount } from "../lib/format";

export interface DelayedWithdrawalTrackerProps {
  requests: DelayedWithdrawalRequest[];
  assetDisplayName: string;
  onClaim?: (requestId: number) => Promise<void>;
  onCancel?: (requestId: number) => Promise<void>;
}

/**
 * Visual tracker for delayed strategy withdrawals.
 * Renders queue states (pending, ready, fulfilled, failed), position in line,
 * remaining/claimable assets, and provides direct claim or cancel triggers.
 */
export const DelayedWithdrawalTracker: FC<DelayedWithdrawalTrackerProps> = ({
  requests,
  assetDisplayName,
  onClaim,
  onCancel,
}) => {
  const [processingId, setProcessingId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<{ id: number; message: string } | null>(null);

  const handleClaim = async (requestId: number) => {
    if (!onClaim) return;
    setProcessingId(requestId);
    setActionError(null);
    try {
      await onClaim(requestId);
    } catch (err) {
      setActionError({
        id: requestId,
        message: err instanceof Error ? err.message : "Failed to claim liquidity",
      });
    } finally {
      setProcessingId(null);
    }
  };

  const handleCancel = async (requestId: number) => {
    if (!onCancel) return;
    setProcessingId(requestId);
    setActionError(null);
    try {
      await onCancel(requestId);
    } catch (err) {
      setActionError({
        id: requestId,
        message: err instanceof Error ? err.message : "Failed to cancel request",
      });
    } finally {
      setProcessingId(null);
    }
  };

  if (requests.length === 0) {
    return null;
  }

  return (
    <section
      aria-labelledby="delayed-withdrawals-heading"
      className="space-y-4 rounded-2xl border border-white/10 bg-black/40 p-5 backdrop-blur"
    >
      <div className="flex items-center justify-between">
        <h3 id="delayed-withdrawals-heading" className="text-lg font-semibold text-white">
          Delayed Strategy Withdrawals
        </h3>
        <span className="rounded-full bg-white/5 px-2.5 py-0.5 text-xs text-gray-400">
          {requests.length} {requests.length === 1 ? "Request" : "Requests"}
        </span>
      </div>

      <p className="text-xs text-gray-400 leading-relaxed">
        Withdrawals from active yield strategies process through a FIFO liquidity queue. Once liquidity is returned by the strategy, your funds become claimable.
      </p>

      <div className="space-y-3" role="list">
        {requests.map((req) => {
          const isProcessing = processingId === req.requestId;
          const reqError = actionError?.id === req.requestId ? actionError.message : null;

          return (
            <div
              key={req.requestId}
              role="listitem"
              className="rounded-xl border border-white/10 bg-[#120505] p-4 transition-colors"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {req.queueState === "pending" && (
                    <span className="inline-flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-400">
                      <Clock className="h-3.5 w-3.5 animate-pulse" />
                      Pending Liquidity
                    </span>
                  )}
                  {req.queueState === "ready" && (
                    <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-400">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Ready to Claim
                    </span>
                  )}
                  {req.queueState === "fulfilled" && (
                    <span className="inline-flex items-center gap-1.5 rounded-md bg-blue-500/10 px-2.5 py-1 text-xs font-medium text-blue-400">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Fulfilled
                    </span>
                  )}
                  {req.queueState === "failed" && (
                    <span className="inline-flex items-center gap-1.5 rounded-md bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-400">
                      <XCircle className="h-3.5 w-3.5" />
                      Failed / Cancelled
                    </span>
                  )}
                  <span className="text-xs text-gray-400">Request #{req.requestId}</span>
                </div>

                {req.queueState === "pending" && (
                  <span className="text-xs font-medium text-amber-300">
                    Queue Position: #{req.positionInQueue + 1}
                  </span>
                )}
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                <div className="rounded-lg bg-black/20 p-2">
                  <div className="text-[11px] text-gray-500">Total Owed</div>
                  <div className="font-medium text-white">
                    {formatAmount(req.assetsOwed, assetDisplayName)}
                  </div>
                </div>
                <div className="rounded-lg bg-black/20 p-2">
                  <div className="text-[11px] text-gray-500">Ready to Claim</div>
                  <div className="font-medium text-emerald-400">
                    {formatAmount(req.claimableAssets, assetDisplayName)}
                  </div>
                </div>
                <div className="rounded-lg bg-black/20 p-2">
                  <div className="text-[11px] text-gray-500">Remaining in Queue</div>
                  <div className="font-medium text-gray-300">
                    {formatAmount(req.remainingAssets, assetDisplayName)}
                  </div>
                </div>
                <div className="rounded-lg bg-black/20 p-2">
                  <div className="text-[11px] text-gray-500">Already Claimed</div>
                  <div className="font-medium text-gray-400">
                    {formatAmount(req.assetsClaimed, assetDisplayName)}
                  </div>
                </div>
              </div>

              {reqError && (
                <div className="mt-3 flex items-center gap-2 rounded-lg bg-rose-950/40 p-2.5 text-xs text-rose-300">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{reqError}</span>
                </div>
              )}

              <div className="mt-3 flex items-center justify-end gap-2">
                {req.queueState === "pending" && req.canCancel && onCancel && (
                  <button
                    type="button"
                    onClick={() => handleCancel(req.requestId)}
                    disabled={isProcessing}
                    aria-label={`Cancel withdrawal request #${req.requestId}`}
                    className="rounded-lg border border-red-500/30 bg-transparent px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-950/30 disabled:opacity-50"
                  >
                    {isProcessing ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      "Cancel Request"
                    )}
                  </button>
                )}

                {req.queueState === "ready" && onClaim && (
                  <button
                    type="button"
                    onClick={() => handleClaim(req.requestId)}
                    disabled={isProcessing}
                    aria-label={`Claim ${formatAmount(req.claimableAssets, assetDisplayName)} for request #${req.requestId}`}
                    className="flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 px-4 py-1.5 text-xs font-semibold text-white shadow hover:from-emerald-500 hover:to-teal-500 disabled:opacity-50"
                  >
                    {isProcessing ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <>
                        <span>Claim Liquidity</span>
                        <ArrowRight className="h-3 w-3" />
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};
