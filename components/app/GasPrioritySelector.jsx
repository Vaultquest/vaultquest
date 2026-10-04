"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  Clock,
  Database,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import {
  AVALANCHE_FEE_CONFIG,
  FEE_STALE_AFTER_MS,
  STELLAR_FEE_CONFIG,
  buildAvalancheFeeEstimate,
  buildStellarFeeEstimate,
  classifyFeeFreshness,
  fetchAvalancheGasPrice,
  fetchStellarFeeStats,
} from "@/lib/chain-fee-adapters";

export const PRIORITY_TIERS = [
  {
    key: "low",
    label: "Low",
    description: "Best effort routing with the lowest estimated fee.",
    multiplier: 0.85,
    eta: "6-8s",
  },
  {
    key: "medium",
    label: "Medium",
    description: "Balanced speed for standard deposit flows.",
    multiplier: 1,
    eta: "3-5s",
  },
  {
    key: "high",
    label: "High",
    description: "Higher inclusion priority for busy network windows.",
    multiplier: 1.25,
    eta: "1-2s",
  },
];

const EMPTY_STELLAR_FEES = {
  baseFeeStroops: STELLAR_FEE_CONFIG.fallbackBaseFeeStroops,
  sourceLedger: null,
  horizonUrl: null,
  fetchedAt: null,
};

function formatUsd(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value);
}

function formatToken(value, token) {
  const precision = token === "XLM" ? 7 : value < 1 ? 5 : 4;
  return `${Number(value || 0).toFixed(precision)} ${token}`;
}

/**
 * Fee priority selector. Vault deposit/withdraw paths must pass network="stellar"
 * (the default). Avalanche is only rendered when explicitly requested for a
 * separately routed product — Stellar paths never show wei, chain ID, or
 * Avalanche RPC controls.
 */
export default function GasPrioritySelector({
  network = "stellar",
  networkType = "testnet",
  nativeBalance = 0,
  customHorizonUrl,
  isUnsupported = false,
  simulationResourceFee = 0,
  onChange,
}) {
  const [priorityKey, setPriorityKey] = useState("medium");
  const [stellarSample, setStellarSample] = useState(null);
  const [avalancheFees, setAvalancheFees] = useState({
    gasPriceWei: AVALANCHE_FEE_CONFIG.fallbackGasPriceWei,
    fetchedAt: null,
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [feeNow, setFeeNow] = useState(() => Date.now());

  const isStellar = network === "stellar";
  const stellarContext = useMemo(
    () => ({ networkType, customHorizonUrl, isStellar, isUnsupported }),
    [customHorizonUrl, isStellar, isUnsupported, networkType],
  );
  // Mask an earlier context during the render that changes the network/source,
  // before effects can emit a callback or the matching request can complete.
  const stellarFees =
    stellarSample?.context === stellarContext
      ? stellarSample.fees
      : EMPTY_STELLAR_FEES;
  const tier = PRIORITY_TIERS.find((item) => item.key === priorityKey) ?? PRIORITY_TIERS[1];
  const nativeToken = isStellar
    ? STELLAR_FEE_CONFIG.nativeToken
    : AVALANCHE_FEE_CONFIG.nativeToken;

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function loadFees() {
      if (isUnsupported) {
        setIsLoading(false);
        setError("Unsupported network");
        return;
      }

      setIsLoading(true);
      setError(null);

      try {
        if (isStellar) {
          const result = await fetchStellarFeeStats({
            networkType,
            customHorizonUrl,
            signal: controller.signal,
          });
          if (cancelled) return;
          setFeeNow(Date.now());
          setStellarSample({
            context: stellarContext,
            fees: {
              baseFeeStroops: result.baseFeeStroops,
              sourceLedger: result.sourceLedger,
              horizonUrl: result.horizonUrl,
              fetchedAt: result.fetchedAt,
            },
          });
        } else {
          const result = await fetchAvalancheGasPrice();
          if (cancelled) return;
          setAvalancheFees({
            gasPriceWei: result.gasPriceWei,
            fetchedAt: result.fetchedAt,
          });
        }
      } catch (fetchError) {
        if (cancelled) return;
        if (isStellar) {
          setStellarSample((prev) => ({
            context: stellarContext,
            fees: {
              ...(prev?.context === stellarContext
                ? prev.fees
                : EMPTY_STELLAR_FEES),
              baseFeeStroops: STELLAR_FEE_CONFIG.fallbackBaseFeeStroops,
              sourceLedger: null,
              fetchedAt: new Date(),
            },
          }));
        } else {
          setAvalancheFees({
            gasPriceWei: AVALANCHE_FEE_CONFIG.fallbackGasPriceWei,
            fetchedAt: new Date(),
          });
        }
        setError(fetchError instanceof Error ? fetchError.message : "Fee lookup failed");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    loadFees();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    customHorizonUrl,
    isStellar,
    isUnsupported,
    networkType,
    refreshTick,
    stellarContext,
  ]);

  useEffect(() => {
    if (!isStellar || isUnsupported || !stellarFees.sourceLedger || !stellarFees.fetchedAt) {
      return;
    }
    const expiresAt = new Date(stellarFees.fetchedAt).getTime() + FEE_STALE_AFTER_MS;
    if (feeNow >= expiresAt) return;

    // Expire an idle sample without polling or waiting for a user interaction.
    const timeout = setTimeout(
      () => setFeeNow(Date.now()),
      Math.max(0, expiresAt - Date.now()),
    );
    return () => clearTimeout(timeout);
  }, [feeNow, isStellar, isUnsupported, stellarFees.fetchedAt, stellarFees.sourceLedger]);

  const feeSummary = useMemo(() => {
    if (isStellar) {
      const estimate = buildStellarFeeEstimate({
        baseFeeStroops: stellarFees.baseFeeStroops,
        simulationResourceFee,
        multiplier: tier.multiplier,
        sourceLedger: stellarFees.sourceLedger,
        fetchedAt: stellarFees.fetchedAt,
        networkType,
        horizonUrl: stellarFees.horizonUrl,
        priorityKey: tier.key,
        isUnsupported,
        now: feeNow,
      });
      return {
        estimatedNative: estimate.estimatedNative,
        estimatedUsd: estimate.estimatedUsd,
        feeStroops: estimate.feeStroops,
        payload: estimate,
        sourceLedger: estimate.sourceLedger,
        freshness: estimate.freshness,
        isStale: estimate.isStale,
      };
    }

    const estimate = buildAvalancheFeeEstimate({
      gasPriceWei: avalancheFees.gasPriceWei,
      multiplier: tier.multiplier,
      priorityKey: tier.key,
      fetchedAt: avalancheFees.fetchedAt,
      isUnsupported,
    });
    return {
      estimatedNative: estimate.estimatedNative,
      estimatedUsd: estimate.estimatedUsd,
      feeStroops: null,
      payload: estimate,
      sourceLedger: null,
      freshness: estimate.freshness,
      isStale: Boolean(error) || isUnsupported,
    };
  }, [
    avalancheFees.fetchedAt,
    avalancheFees.gasPriceWei,
    error,
    feeNow,
    isStellar,
    isUnsupported,
    networkType,
    simulationResourceFee,
    stellarFees.baseFeeStroops,
    stellarFees.fetchedAt,
    stellarFees.horizonUrl,
    stellarFees.sourceLedger,
    tier,
  ]);

  const freshnessStatus = isStellar
    ? classifyFeeFreshness({
        fetchedAt: stellarFees.fetchedAt,
        sourceLedger: stellarFees.sourceLedger,
        isUnsupported,
        now: feeNow,
      })
    : isUnsupported
      ? "unsupported"
      : error
        ? "stale"
        : "fresh";

  useEffect(() => {
    onChange?.({
      network: isStellar ? "Stellar" : "Avalanche",
      networkType: isStellar ? networkType : undefined,
      tier,
      estimatedNative: feeSummary.estimatedNative,
      estimatedUsd: feeSummary.estimatedUsd,
      payload: feeSummary.payload,
      sourceLedger: isStellar ? feeSummary.sourceLedger : null,
      freshness: feeSummary.freshness,
      isStale: feeSummary.isStale || freshnessStatus === "stale",
      isUnsupported,
    });
  }, [
    feeSummary,
    freshnessStatus,
    isStellar,
    isUnsupported,
    networkType,
    onChange,
    tier,
  ]);

  const nativeBalanceValue = Number(nativeBalance) || 0;
  const hasEnoughBalance = nativeBalanceValue >= feeSummary.estimatedNative;

  return (
    <section className="vq-glass-hover p-5 sm:p-6" data-testid="gas-priority-selector">
      <div className="flex flex-col gap-3 border-b border-vault-border/40 pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.24em] text-vault-muted">
            {isStellar ? "Stellar transaction fee" : "Gas priority"}
          </p>
          <h2 className="mt-1 text-xl font-semibold text-vault-text">
            {isStellar ? "Stellar fee selector" : "Real-time fee selector"}
          </h2>
          {isStellar && (
            <p className="mt-1 text-xs text-vault-muted">
              Uses Horizon fee_stats plus optional Soroban simulation resource fee.
              Units are stroops from Horizon fee_stats; EVM gas controls are not part of
              this path.
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setRefreshTick((value) => value + 1)}
          disabled={isLoading || isUnsupported}
          className="vq-btn-ghost self-start sm:self-auto disabled:opacity-50"
          data-testid="refresh-fees-btn"
        >
          <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
          Refresh rates
        </button>
      </div>

      {isUnsupported && (
        <div
          role="alert"
          data-testid="unsupported-network-alert"
          className="mt-5 flex items-start gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100"
        >
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" aria-hidden="true" />
          <div>
            <p className="font-semibold text-vault-text">Unsupported network</p>
            <p className="mt-1 text-vault-muted">
              Fee estimates are unavailable for this network. Switch to Stellar
              testnet or mainnet to continue.
            </p>
          </div>
        </div>
      )}

      <div className="mt-5 grid gap-3 md:grid-cols-3">
        {PRIORITY_TIERS.map((item) => {
          const selected = item.key === priorityKey;
          let estimatedNative;
          if (isStellar) {
            const estimate = buildStellarFeeEstimate({
              baseFeeStroops: stellarFees.baseFeeStroops,
              simulationResourceFee,
              multiplier: item.multiplier,
              sourceLedger: stellarFees.sourceLedger,
              fetchedAt: stellarFees.fetchedAt,
              networkType,
              horizonUrl: stellarFees.horizonUrl,
              priorityKey: item.key,
              isUnsupported,
            });
            estimatedNative = estimate.estimatedNative;
          } else {
            estimatedNative = buildAvalancheFeeEstimate({
              gasPriceWei: avalancheFees.gasPriceWei,
              multiplier: item.multiplier,
              priorityKey: item.key,
              fetchedAt: avalancheFees.fetchedAt,
              isUnsupported,
            }).estimatedNative;
          }

          return (
            <button
              key={item.key}
              type="button"
              data-testid={`tier-btn-${item.key}`}
              disabled={isUnsupported}
              onClick={() => setPriorityKey(item.key)}
              className={`rounded-2xl border p-4 text-left transition-all duration-300 disabled:cursor-not-allowed disabled:opacity-50 ${
                selected
                  ? "border-red-400/40 bg-red-500/10 shadow-glow"
                  : "border-vault-border/50 bg-vault-surface/25 hover:border-red-400/25 hover:bg-vault-surface/40"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-base font-semibold text-vault-text">{item.label}</p>
                  <p className="mt-1 text-xs text-vault-muted">{item.description}</p>
                </div>
                <span
                  className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.24em] ${
                    selected ? "bg-red-500/15 text-red-500" : "bg-vault-border/30 text-vault-muted"
                  }`}
                >
                  {item.eta}
                </span>
              </div>
              <div className="mt-4 flex items-center justify-between text-sm">
                <span className="text-vault-muted">Estimated fee</span>
                <span className="font-semibold text-vault-text">
                  {formatToken(estimatedNative, nativeToken)}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <div className="vq-glass p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-vault-muted">
            {isStellar ? "Base fee" : "Live rate"}
          </p>
          <p className="mt-1 text-lg font-semibold text-vault-text" data-testid="metric-base-fee">
            {isLoading
              ? "Updating…"
              : isStellar
                ? `${Number(stellarFees.baseFeeStroops).toLocaleString()} stroops`
                : `${Number(avalancheFees.gasPriceWei).toLocaleString()} wei`}
          </p>
          <p className="mt-1 text-xs text-vault-muted">
            {isStellar
              ? `Network: ${networkType} · token ${STELLAR_FEE_CONFIG.nativeToken}`
              : `${AVALANCHE_FEE_CONFIG.label} gas price`}
          </p>
        </div>

        <div className="vq-glass p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-vault-muted flex items-center gap-1">
            <Database className="h-3.5 w-3.5" aria-hidden="true" />
            {isStellar ? "Source ledger" : "Estimated cost"}
          </p>
          {isStellar ? (
            <>
              <p className="mt-1 text-lg font-semibold text-vault-text" data-testid="metric-ledger">
                {stellarFees.sourceLedger ? `#${stellarFees.sourceLedger}` : "Fallback ledger"}
              </p>
              <p className="mt-1 text-xs text-vault-muted truncate" title={stellarFees.horizonUrl ?? undefined}>
                {stellarFees.horizonUrl
                  ? `Horizon: ${stellarFees.horizonUrl.replace(/^https?:\/\//, "")}`
                  : "Waiting for Horizon fee_stats"}
              </p>
            </>
          ) : (
            <>
              <p className="mt-1 text-lg font-semibold text-vault-text">
                {formatToken(feeSummary.estimatedNative, nativeToken)}
              </p>
              <p className="mt-1 text-xs text-vault-muted">
                {formatUsd(feeSummary.estimatedUsd)}
              </p>
            </>
          )}
        </div>

        <div
          className={`vq-glass p-4 ${
            freshnessStatus === "fresh" && hasEnoughBalance
              ? ""
              : "border-amber-400/30 bg-amber-500/10"
          }`}
        >
          <p className="text-xs font-medium uppercase tracking-wide text-vault-muted flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
            Freshness
          </p>
          <p
            className={`mt-1 text-lg font-semibold ${
              freshnessStatus === "fresh"
                ? "text-emerald-500 dark:text-emerald-400"
                : "text-amber-500 dark:text-amber-400"
            }`}
            data-testid="metric-freshness"
          >
            {isLoading
              ? "Updating…"
              : freshnessStatus === "unsupported"
                ? "Unsupported"
                : freshnessStatus === "stale"
                  ? "Stale data"
                  : "Live rate"}
          </p>
          <p className="mt-1 text-xs text-vault-muted">
            {feeSummary.freshness
              ? `Fetched ${new Date(feeSummary.freshness).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                  second: "2-digit",
                })}`
              : "No fee sample yet"}
            {isStellar && !hasEnoughBalance ? " · XLM balance low" : ""}
          </p>
        </div>
      </div>

      {isStellar && (
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <div className="vq-glass p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-vault-muted">
              Estimated cost
            </p>
            <p className="mt-1 text-lg font-semibold text-vault-text">
              {formatToken(feeSummary.estimatedNative, nativeToken)}
            </p>
            <p className="mt-1 text-xs text-vault-muted">
              {formatUsd(feeSummary.estimatedUsd)}
              {Number(simulationResourceFee) > 0
                ? ` · includes ${Number(simulationResourceFee).toLocaleString()} stroops resource fee`
                : ""}
            </p>
          </div>
          <div
            className={`vq-glass p-4 ${
              hasEnoughBalance ? "" : "border-amber-400/30 bg-amber-500/10"
            }`}
          >
            <p className="text-xs font-medium uppercase tracking-wide text-vault-muted">
              Balance check
            </p>
            <p
              className={`mt-1 text-lg font-semibold ${
                hasEnoughBalance
                  ? "text-emerald-500 dark:text-emerald-400"
                  : "text-amber-500 dark:text-amber-400"
              }`}
            >
              {hasEnoughBalance ? "Ready to send" : "Fee balance low"}
            </p>
            <p className="mt-1 text-xs text-vault-muted">
              Wallet: {formatToken(nativeBalanceValue, nativeToken)}
            </p>
          </div>
        </div>
      )}

      {(error || (!hasEnoughBalance && !isUnsupported) || freshnessStatus === "stale") &&
        !isUnsupported && (
          <div
            role="alert"
            aria-live="assertive"
            data-testid="fee-warning-alert"
            className="mt-5 flex items-start gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100"
          >
            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" aria-hidden="true" />
            <div>
              <p className="font-semibold text-vault-text">
                {freshnessStatus === "stale" || error ? "Stale fee notice" : "Network warning"}
              </p>
              <p className="mt-1 text-vault-muted">
                {error
                  ? `${error}. Showing fallback fee data while Horizon is unavailable.`
                  : freshnessStatus === "stale"
                    ? "Fee data is stale or missing a source ledger. Refresh before signing."
                    : `Your wallet balance is below the estimated ${nativeToken} fee for the ${tier.label.toLowerCase()} priority tier.`}
              </p>
            </div>
          </div>
        )}

      <div className="mt-5 grid gap-3 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-2xl border border-vault-border/50 bg-vault-surface/25 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-vault-text">
            <Activity className="h-4 w-4 text-red-500" aria-hidden="true" />
            Execution payload
          </div>
          <pre className="mt-3 overflow-auto rounded-xl bg-slate-950/80 p-4 text-xs leading-relaxed text-slate-200">
            {JSON.stringify(
              {
                network: isStellar ? "Stellar" : AVALANCHE_FEE_CONFIG.label,
                priority: tier.label,
                estimatedNative: formatToken(feeSummary.estimatedNative, nativeToken),
                estimatedUsd: formatUsd(feeSummary.estimatedUsd),
                payload: feeSummary.payload,
              },
              null,
              2,
            )}
          </pre>
        </div>

        <div className="rounded-2xl border border-vault-border/50 bg-vault-surface/25 p-4">
          <p className="text-sm font-semibold text-vault-text">Live status</p>
          <p className="mt-2 text-sm text-vault-muted">
            {feeSummary.freshness
              ? `Updated ${new Date(feeSummary.freshness).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                })}`
              : "Fetching fresh fee data from the network"}
          </p>
          <div className="mt-4 rounded-2xl border border-vault-border/40 bg-vault-surface/40 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-vault-muted">
              Selected tier
            </p>
            <p className="mt-1 text-lg font-semibold text-vault-text">{tier.label}</p>
            <p className="mt-1 text-xs text-vault-muted">{tier.description}</p>
            <div className="mt-4 flex items-center gap-2 text-sm font-semibold text-red-500 dark:text-red-400">
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              {tier.eta} target inclusion
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
