"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { X, Loader2, CheckCircle2, AlertTriangle, ArrowLeft, RefreshCw } from "lucide-react";
import GasPrioritySelector from "@/components/app/GasPrioritySelector";
import {
  previewDepositDetailed,
  formatAssetAmount,
  isPoolStateStale,
  VaultMathError,
} from "@/lib/safe-amount";

/**
 * Formats token balances for display with fixed decimal precision.
 */
function formatToken(value, token) {
  return `${Number(value || 0).toFixed(token === "XLM" ? 6 : 4)} ${token}`;
}

const DEFAULT_POOL_SNAPSHOT = {
  total_shares: 10_000_000_000_000n,
  total_assets: 10_000_000_000n,
  pending_withdrawals: 0n,
  accrued_fees: 0n,
  high_water_mark: 1_000_000_000_000n,
  last_fee_time: 0n,
  version: 1n,
  updatedAt: new Date().toISOString(),
};

/**
 * Modal dialog for depositing assets into a prize vault with contract share preview.
 */
export default function DepositModal({
  isOpen,
  onClose,
  pool,
  poolSnapshot: initialSnapshot,
  nativeBalance = 1.0,
  onDeposit,
  onRefresh,
}) {
  const dialogRef = useRef(null);
  const closeButtonRef = useRef(null);
  const [step, setStep] = useState("input");
  const [amount, setAmount] = useState("250");
  const [feeState, setFeeState] = useState(null);
  const [error, setError] = useState(null);
  const [currentSnapshot, setCurrentSnapshot] = useState(initialSnapshot || DEFAULT_POOL_SNAPSHOT);

  const walletBalance = nativeBalance;
  const usdcBalance = 1000.0;

  const gasBudget = useMemo(() => feeState?.estimatedNative ?? 0, [feeState]);

  const handleRefreshSnapshot = useCallback(() => {
    if (onRefresh) {
      onRefresh();
    } else {
      setCurrentSnapshot((prev) => ({
        ...prev,
        updatedAt: new Date().toISOString(),
      }));
    }
  }, [onRefresh]);

  const isStale = useMemo(() => {
    return isPoolStateStale(currentSnapshot?.updatedAt);
  }, [currentSnapshot]);

  const parsedAmountStroops = useMemo(() => {
    const num = parseFloat(amount);
    if (!amount || isNaN(num) || num <= 0) return null;
    return BigInt(Math.round(num * 1e7));
  }, [amount]);

  const preview = useMemo(() => {
    if (!parsedAmountStroops) return null;
    try {
      return previewDepositDetailed({
        snapshot: currentSnapshot,
        assets: parsedAmountStroops,
        decimals: 7,
      });
    } catch (err) {
      return { error: err };
    }
  }, [parsedAmountStroops, currentSnapshot]);

  useEffect(() => {
    if (!isOpen) {
      setStep("input");
      setError(null);
      return undefined;
    }

    const previouslyFocused = document.activeElement;
    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());

    const onKeyDown = (event) => {
      if (event.key === "Escape" && step !== "loading") {
        onClose?.();
      }

      if (event.key === "Tab" && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
          ),
        );
        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (focusable.length === 0) {
          event.preventDefault();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [isOpen, onClose, step]);

  if (!isOpen) {
    return null;
  }

  const isGasShort = walletBalance < gasBudget;

  const handleContinue = () => {
    const amountNum = parseFloat(amount);
    if (!amount || isNaN(amountNum)) {
      setError("Please enter a valid amount.");
      return;
    }
    if (amountNum <= 0) {
      setError("Amount must be greater than 0.");
      return;
    }
    if (amountNum > usdcBalance) {
      setError("Amount exceeds your available USDC balance.");
      return;
    }
    if (preview?.error instanceof VaultMathError) {
      if (preview.error.kind === "RoundsToZero") {
        setError("Deposit amount is too small to mint vault shares (rounds to zero).");
        return;
      }
      setError(preview.error.message);
      return;
    }
    if (isGasShort) {
      setError("Insufficient AVAX to cover the estimated gas fee.");
      return;
    }
    setError(null);
    setStep("confirm");
  };

  const handleConfirmDeposit = () => {
    setStep("loading");
    if (onDeposit) {
      onDeposit(amount)
        .then(() => setStep("success"))
        .catch((err) => {
          setError(err?.message || "Deposit transaction failed");
          setStep("confirm");
        });
    } else {
      setTimeout(() => {
        setStep("success");
      }, 1800);
    }
  };

  const getHeaderTitle = () => {
    switch (step) {
      case "confirm":
        return "Confirm transaction";
      case "loading":
        return "Broadcasting transaction";
      case "success":
        return "Transaction confirmed";
      case "input":
      default:
        return "Review gas before signing";
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/70 px-4 py-6 backdrop-blur-sm sm:items-center">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="deposit-dialog-title"
        className="vq-glass w-full max-w-5xl overflow-hidden border border-vault-border/60 shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-vault-border/40 px-5 py-4 sm:px-6">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.22em] text-vault-muted">
              Deposit flow
            </p>
            <h2 id="deposit-dialog-title" className="mt-1 text-xl font-semibold text-vault-text">
              {getHeaderTitle()}
            </h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="vq-btn-ghost h-10 w-10 rounded-full p-0 disabled:opacity-40"
            aria-label="Close deposit modal"
            disabled={step === "loading"}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="p-5 lg:p-6">
          {step === "input" && (
            <div className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
              <section className="space-y-4 rounded-3xl border border-vault-border/40 bg-vault-surface/30 p-5">
                {isStale && (
                  <div
                    role="alert"
                    className="flex items-start justify-between gap-3 rounded-2xl border border-amber-400/40 bg-amber-500/10 p-4 text-sm text-amber-200"
                  >
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
                      <div>
                        <p className="font-semibold text-amber-100">Stale pool data</p>
                        <p className="mt-1 text-xs text-amber-200/80">
                          Vault data is older than 2 minutes. Share preview and fee calculations may
                          not reflect latest on-chain state.
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={handleRefreshSnapshot}
                      aria-label="Refresh pool data"
                      className="vq-btn-ghost flex shrink-0 items-center gap-1 text-xs text-amber-300 hover:text-amber-100"
                    >
                      <RefreshCw className="h-3.5 w-3.5" /> Refresh
                    </button>
                  </div>
                )}

                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-vault-muted">
                    Deposit amount
                  </p>
                  <label htmlFor="deposit-amount" className="sr-only">
                    Deposit amount
                  </label>
                  <input
                    id="deposit-amount"
                    value={amount}
                    onChange={(event) => {
                      setAmount(event.target.value);
                      setError(null);
                    }}
                    inputMode="decimal"
                    className={`mt-2 w-full rounded-2xl border bg-vault-surface px-4 py-3 text-lg font-semibold text-vault-text outline-none transition focus:ring-2 ${
                      error
                        ? "border-red-500/50 focus:border-red-500 focus:ring-red-500/25"
                        : "border-vault-border focus:border-red-400 focus:ring-red-400/25"
                    }`}
                    placeholder="0.00"
                  />
                  {error && (
                    <p className="mt-2 text-sm font-semibold text-red-500" role="alert">
                      {error}
                    </p>
                  )}
                  <div className="mt-2 flex justify-between text-xs text-vault-muted">
                    <span>Demo USDC balance: {usdcBalance.toFixed(2)} USDC</span>
                    <span>Demo AVAX balance: {formatToken(walletBalance, "AVAX")}</span>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border border-vault-border/40 bg-vault-surface/35 p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-vault-muted">
                      Expected shares to receive
                    </p>
                    <p className="mt-1 text-lg font-semibold text-vault-text">
                      {preview && !preview.error ? `${preview.sharesMintedFormatted} vUSDC` : "—"}
                    </p>
                    <p className="mt-1 text-[11px] text-vault-muted">
                      Floor division (favors existing pool)
                    </p>
                  </div>
                  <div className="rounded-2xl border border-vault-border/40 bg-vault-surface/35 p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-vault-muted">
                      Pool share impact
                    </p>
                    <p className="mt-1 text-lg font-semibold text-vault-text">
                      {preview && !preview.error
                        ? `${(Number(preview.poolShareBps) / 100).toFixed(2)}%`
                        : "—"}
                    </p>
                    <p className="mt-1 text-[11px] text-vault-muted">
                      Net assets:{" "}
                      {preview && !preview.error
                        ? formatAssetAmount(preview.netAssetsAfter, 7)
                        : "—"}{" "}
                      USDC
                    </p>
                  </div>
                </div>

                <div className="rounded-2xl border border-vault-border/40 bg-slate-950/75 p-4 text-sm text-slate-200">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                    Transaction payload
                  </p>
                  <pre className="mt-2 overflow-auto text-xs leading-relaxed text-slate-200">
                    {JSON.stringify(
                      {
                        amount,
                        expectedShares:
                          preview && !preview.error ? preview.sharesMintedFormatted : "0",
                        gasBudget: formatToken(gasBudget, "AVAX"),
                        balance: formatToken(walletBalance, "AVAX"),
                      },
                      null,
                      2,
                    )}
                  </pre>
                </div>

                {isGasShort && (
                  <div
                    role="alert"
                    aria-live="assertive"
                    className="rounded-2xl border border-amber-400/35 bg-amber-500/10 p-4 text-sm text-amber-100"
                  >
                    <p className="font-semibold text-vault-text">Network warning</p>
                    <p className="mt-1 text-vault-muted">
                      The connected wallet does not have enough native token to cover the selected gas
                      fee.
                    </p>
                  </div>
                )}
              </section>

              <GasPrioritySelector nativeBalance={walletBalance} onChange={setFeeState} />
            </div>
          )}

          {step === "confirm" && (
            <section className="mx-auto my-2 max-w-2xl space-y-6 rounded-3xl border border-vault-border/40 bg-vault-surface/30 p-6">
              <div className="text-center">
                <p className="text-xs font-medium uppercase tracking-[0.24em] text-vault-muted">
                  Review transaction
                </p>
                <h3 className="mt-2 text-2xl font-bold text-vault-text">Deposit Confirmation</h3>
              </div>

              <div className="space-y-3 divide-y divide-vault-border rounded-2xl border border-vault-border/40 bg-vault-surface/40 px-6 py-2">
                <div className="flex justify-between py-2.5">
                  <span className="text-vault-muted">Amount to Deposit</span>
                  <span className="font-bold text-vault-text">{amount} USDC</span>
                </div>
                <div className="flex justify-between py-2.5">
                  <span className="text-vault-muted">Expected Shares to Mint</span>
                  <span className="font-bold text-emerald-400">
                    {preview && !preview.error ? `${preview.sharesMintedFormatted} vUSDC` : "—"}
                  </span>
                </div>
                <div className="flex justify-between py-2.5">
                  <span className="text-vault-muted">Share Math Invariant</span>
                  <span className="text-sm font-medium text-vault-text">
                    Floor division (Soroban drip-pool)
                  </span>
                </div>
                <div className="flex justify-between py-2.5">
                  <span className="text-vault-muted">Destination Pool</span>
                  <span className="font-medium text-vault-text">
                    {pool?.name || "USDC Stable Pool"}
                  </span>
                </div>
                <div className="flex justify-between py-2.5">
                  <span className="text-vault-muted">Estimated Gas Fee</span>
                  <span className="font-medium text-vault-text">
                    {formatToken(gasBudget, "AVAX")}
                  </span>
                </div>
                <div className="flex justify-between py-2.5 pt-4">
                  <span className="font-semibold text-vault-text">Deduction Summary</span>
                  <span className="font-bold text-red-500">
                    {amount} USDC + {formatToken(gasBudget, "AVAX")}
                  </span>
                </div>
              </div>

              <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-4 text-xs text-vault-muted">
                Yield generated from pooled deposits funds periodic prize drawings. Your original
                deposit principal remains fully withdrawable at any time.
              </div>
            </section>
          )}

          {step === "loading" && (
            <section className="flex flex-col items-center justify-center space-y-4 py-16">
              <div className="flex h-16 w-16 items-center justify-center rounded-full border-2 border-red-500/30">
                <Loader2 className="h-8 w-8 animate-spin text-red-400" />
              </div>
              <h3 className="text-lg font-semibold text-vault-text">Processing Deposit</h3>
              <p className="max-w-xs text-center text-sm text-vault-muted">
                Please approve the transaction in your connected wallet. Broadcasting to the
                network...
              </p>
            </section>
          )}

          {step === "success" && (
            <section className="mx-auto flex max-w-md flex-col items-center justify-center space-y-4 py-8">
              <div className="shadow-glow-green flex h-16 w-16 items-center justify-center rounded-full border border-emerald-500/20 bg-emerald-500/10 text-emerald-500">
                <CheckCircle2 className="h-10 w-10 animate-bounce" />
              </div>
              <h3 className="text-2xl font-bold text-vault-text">Deposit Successful!</h3>
              <p className="text-center text-sm text-vault-muted">
                Your deposit of <strong className="text-vault-text">{amount} USDC</strong> was
                successfully broadcast and confirmed on-chain.
              </p>

              <div className="w-full divide-y divide-vault-border rounded-2xl border border-vault-border/40 bg-vault-surface/40 px-5 py-3 text-xs">
                <div className="flex justify-between py-2">
                  <span className="text-vault-muted">Pool</span>
                  <span className="font-medium text-vault-text">
                    {pool?.name || "USDC Stable Pool"}
                  </span>
                </div>
                <div className="flex justify-between py-2">
                  <span className="text-vault-muted">Shares Received</span>
                  <span className="font-medium text-emerald-400">
                    {preview && !preview.error ? `${preview.sharesMintedFormatted} vUSDC` : "—"}
                  </span>
                </div>
                <div className="flex justify-between py-2">
                  <span className="text-vault-muted">Status</span>
                  <span className="font-bold text-emerald-500">Confirmed</span>
                </div>
              </div>
            </section>
          )}
        </div>

        <div className="flex flex-col gap-3 border-t border-vault-border/40 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="text-sm text-vault-muted">
            {step === "input" &&
              "Selected gas cost is applied to the transaction execution payload before submission."}
            {step === "confirm" &&
              "Double check transaction payload and destination pool details before signing."}
            {step === "loading" &&
              "Do not close this modal or refresh the page while the transaction is broadcasting."}
            {step === "success" &&
              "Transaction completed successfully. You can close this modal."}
          </div>
          <div className="flex gap-3">
            {step === "input" && (
              <>
                <button type="button" onClick={onClose} className="vq-btn-ghost">
                  Cancel
                </button>
                <button type="button" onClick={handleContinue} className="vq-btn-primary">
                  Confirm deposit
                </button>
              </>
            )}
            {step === "confirm" && (
              <>
                <button
                  type="button"
                  onClick={() => setStep("input")}
                  className="vq-btn-ghost"
                >
                  <ArrowLeft className="mr-1 inline h-4 w-4" /> Back
                </button>
                <button
                  type="button"
                  onClick={handleConfirmDeposit}
                  className="vq-btn-primary"
                >
                  Sign & Submit
                </button>
              </>
            )}
            {step === "loading" && (
              <button
                type="button"
                disabled
                className="vq-btn-primary cursor-not-allowed opacity-50"
              >
                Broadcasting...
              </button>
            )}
            {step === "success" && (
              <button type="button" onClick={onClose} className="vq-btn-primary">
                Close
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
