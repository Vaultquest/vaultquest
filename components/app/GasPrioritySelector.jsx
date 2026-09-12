"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Activity, ArrowUpRight, Clock, Database, RefreshCw, ShieldAlert } from "lucide-react";
import { DEFAULT_RPC, getHorizonUrl, readStoredRpc } from "@/lib/customRpc";

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

const STELLAR_CONFIG = {
  nativeToken: "XLM",
  usdRate: 0.13,
  fallbackBaseFee: 100,
  minBaseFee: 100,
};

const AVALANCHE_CONFIG = {
  nativeToken: "AVAX",
  usdRate: 36,
  gasLimit: 180000n,
  fallbackGasPrice: 25_000_000_000n,
};

function formatUsd(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value);
}

function formatToken(value, token) {
  const precision = token === "XLM" ? 6 : value < 1 ? 5 : 4;
  return `${Number(value || 0).toFixed(precision)} ${token}`;
}

function weiToToken(wei, token) {
  const divisor = token === "AVAX" ? 1e18 : 1e7;
  return Number(wei) / divisor;
}

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
  const [feeData, setFeeData] = useState({
    baseFee: STELLAR_CONFIG.fallbackBaseFee,
    sourceLedger: null,
    gasPrice: AVALANCHE_CONFIG.fallbackGasPrice,
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const isStellar = network === "stellar";
  const tier = PRIORITY_TIERS.find((item) => item.key === priorityKey) ?? PRIORITY_TIERS[1];

  // Resolve active Horizon endpoint for Stellar queries
  const resolvedHorizonUrl = useMemo(() => {
    if (!isStellar) return null;
    if (customHorizonUrl) return customHorizonUrl.replace(/\/+$/, "");
    try {
      const stored = readStoredRpc()?.horizon;
      if (stored && stored !== DEFAULT_RPC.horizon) {
        return stored.replace(/\/+$/, "");
      }
    } catch {
      // Fall through to network default
    }
    return networkType === "mainnet"
      ? "https://horizon.stellar.org"
      : "https://horizon-testnet.stellar.org";
  }, [customHorizonUrl, isStellar, networkType]);

  useEffect(() => {
    let cancelled = false;

    async function loadFees() {
      if (isUnsupported) {
        setIsLoading(false);
        setError("Unsupported network");
        return;
      }

      setIsLoading(true);
      setError(null);

      if (isStellar) {
        try {
          const endpoint = `${resolvedHorizonUrl}/fee_stats`;
          const response = await fetch(endpoint, {
            headers: { accept: "application/json" },
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status} from Horizon fee_stats`);
          }

          const data = await response.json();
          if (cancelled) return;

          const rawBaseFee = Number(data?.last_ledger_base_fee);
          const baseFee = isNaN(rawBaseFee) || rawBaseFee <= 0 ? STELLAR_CONFIG.fallbackBaseFee : rawBaseFee;
          const sourceLedger = data?.last_ledger != null ? String(data.last_ledger) : null;

          setFeeData((prev) => ({
            ...prev,
            baseFee,
            sourceLedger,
          }));
          setUpdatedAt(new Date());
        } catch (fetchError) {
          if (cancelled) return;
          setFeeData((prev) => ({
            ...prev,
            baseFee: STELLAR_CONFIG.fallbackBaseFee,
            sourceLedger: null,
          }));
          setError(fetchError instanceof Error ? fetchError.message : "Fee stats lookup failed");
          setUpdatedAt(new Date());
        } finally {
          if (!cancelled) setIsLoading(false);
        }
      } else {
        // Independent Avalanche fee fetcher (EVM non-goal)
        try {
          const response = await fetch("https://api.avax.network/ext/bc/C/rpc", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "eth_gasPrice",
              params: [],
            }),
          });

          if (!response.ok) throw new Error("Unable to fetch Avalanche gas price");

          const data = await response.json();
          if (cancelled) return;

          const gasPrice = typeof data?.result === "string" ? BigInt(data.result) : null;
          setFeeData((prev) => ({
            ...prev,
            gasPrice: gasPrice ?? AVALANCHE_CONFIG.fallbackGasPrice,
          }));
          setUpdatedAt(new Date());
        } catch (fetchError) {
          if (cancelled) return;
          setFeeData((prev) => ({
            ...prev,
            gasPrice: AVALANCHE_CONFIG.fallbackGasPrice,
          }));
          setError(fetchError instanceof Error ? fetchError.message : "Gas price lookup failed");
          setUpdatedAt(new Date());
        } finally {
          if (!cancelled) setIsLoading(false);
        }
      }
    }

    loadFees();

    return () => {
      cancelled = true;
    };
  }, [isStellar, isUnsupported, refreshTick, resolvedHorizonUrl]);

  const isStale = Boolean(error) || (isStellar && !feeData.sourceLedger);

  const feeSummary = useMemo(() => {
    if (isStellar) {
      const baseFeeStroops = Math.max(
        STELLAR_CONFIG.minBaseFee,
        Math.round(feeData.baseFee * tier.multiplier)
      );
      const resourceFeeStroops = Math.max(0, Math.round(Number(simulationResourceFee) || 0));
      const totalStroops = baseFeeStroops + resourceFeeStroops;
      const estimatedNative = totalStroops / 1e7;
      const estimatedUsd = estimatedNative * STELLAR_CONFIG.usdRate;

      const payload = {
        type: "stellar",
        chain: "Stellar",
        network: networkType,
        priority: tier.key,
        baseFeeStroops,
        resourceFeeStroops,
        feeStroops: totalStroops,
        feeBid: `${(totalStroops / 1e7).toFixed(6)} XLM`,
        sourceLedger: feeData.sourceLedger ?? "fallback",
        freshness: updatedAt ? updatedAt.toISOString() : null,
        isStale,
        unsupported: isUnsupported,
      };

      return {
        estimatedNative,
        estimatedUsd,
        feeStroops: totalStroops,
        payload,
      };
    }

    // EVM Avalanche fallback path
    const currentGasPrice = feeData.gasPrice ?? AVALANCHE_CONFIG.fallbackGasPrice;
    const adjustedGasPrice = BigInt(
      Math.max(1, Math.round(Number(currentGasPrice) * tier.multiplier))
    );
    const estimatedNative = weiToToken(
      adjustedGasPrice * AVALANCHE_CONFIG.gasLimit,
      AVALANCHE_CONFIG.nativeToken
    );
    const estimatedUsd = estimatedNative * AVALANCHE_CONFIG.usdRate;

    const maxPriorityFeePerGas = BigInt(
      Math.max(1, Math.round(Number(currentGasPrice) * 0.12 * tier.multiplier))
    );

    const payload = {
      type: "evm",
      chain: "Avalanche C-Chain",
      priority: tier.key,
      gasLimit: AVALANCHE_CONFIG.gasLimit.toString(),
      maxFeePerGas: adjustedGasPrice.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
      unsupported: isUnsupported,
    };

    return {
      estimatedNative,
      estimatedUsd,
      payload,
    };
  }, [
    feeData.baseFee,
    feeData.gasPrice,
    feeData.sourceLedger,
    isStellar,
    isStale,
    isUnsupported,
    networkType,
    simulationResourceFee,
    tier,
    updatedAt,
  ]);

  useEffect(() => {
    onChange?.({
      network: isStellar ? "Stellar" : "Avalanche",
      networkType,
      tier,
      estimatedNative: feeSummary.estimatedNative,
      estimatedUsd: feeSummary.estimatedUsd,
      payload: feeSummary.payload,
      sourceLedger: isStellar ? feeData.sourceLedger : null,
      freshness: updatedAt ? updatedAt.toISOString() : null,
      isStale,
      isUnsupported,
    });
  }, [
    feeData.sourceLedger,
    feeSummary,
    isStellar,
    isStale,
    isUnsupported,
    networkType,
    onChange,
    tier,
    updatedAt,
  ]);

  const nativeToken = isStellar ? STELLAR_CONFIG.nativeToken : AVALANCHE_CONFIG.nativeToken;
  const nativeBalanceValue = Number(nativeBalance) || 0;
  const hasEnoughBalance = nativeBalanceValue >= feeSummary.estimatedNative;

  return (
    <section className="vq-glass-hover p-5 sm:p-6" data-testid="gas-priority-selector">
      <div className="flex flex-col gap-3 border-b border-vault-border/40 pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.24em] text-vault-muted">
            {isStellar ? "Stellar Transaction Fee" : "Gas Priority"}
          </p>
          <h2 className="mt-1 text-xl font-semibold text-vault-text">
            {isStellar ? "Stellar fee selector" : "Real-time fee selector"}
          </h2>
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
          aria-live="assertive"
          className="mt-5 flex items-start gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200"
          data-testid="unsupported-network-alert"
        >
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" aria-hidden="true" />
          <div>
            <p className="font-semibold text-vault-text">Unsupported Network</p>
            <p className="mt-1 text-vault-muted">
              Connected wallet is on an unsupported network. Please switch to Stellar{" "}
              {networkType === "mainnet" ? "Mainnet" : "Testnet"} in your wallet to estimate transaction fees.
            </p>
          </div>
        </div>
      )}

      {/* Priority Tiers */}
      <div className="mt-5 grid gap-3 md:grid-cols-3">
        {PRIORITY_TIERS.map((item) => {
          const selected = item.key === priorityKey;
          let estimatedTierNative = 0;

          if (isStellar) {
            const tierBase = Math.max(STELLAR_CONFIG.minBaseFee, Math.round(feeData.baseFee * item.multiplier));
            const tierTotal = tierBase + Math.max(0, Math.round(Number(simulationResourceFee) || 0));
            estimatedTierNative = tierTotal / 1e7;
          } else {
            const adjustedGasPrice = feeData.gasPrice ?? AVALANCHE_CONFIG.fallbackGasPrice;
            estimatedTierNative = weiToToken(
              BigInt(Math.max(1, Math.round(Number(adjustedGasPrice) * item.multiplier))) *
                AVALANCHE_CONFIG.gasLimit,
              AVALANCHE_CONFIG.nativeToken
            );
          }

          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setPriorityKey(item.key)}
              disabled={isUnsupported}
              data-testid={`tier-btn-${item.key}`}
              className={`rounded-2xl border p-4 text-left transition-all duration-300 disabled:opacity-50 ${
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
                  {formatToken(estimatedTierNative, nativeToken)}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Metrics Grid */}
      <div className="mt-5 grid gap-3 sm:grid-cols-4">
        <div className="vq-glass p-4" data-testid="metric-base-fee">
          <p className="text-xs font-medium uppercase tracking-wide text-vault-muted">
            {isStellar ? "Base fee" : "Live rate"}
          </p>
          <p className="mt-1 text-lg font-semibold text-vault-text">
            {isLoading
              ? "Updating…"
              : isStellar
              ? `${Number(feeData.baseFee).toLocaleString()} stroops`
              : `${Number(feeData.gasPrice).toLocaleString()} wei`}
          </p>
          <p className="mt-1 text-xs text-vault-muted">
            {isStellar ? "Stellar network base rate" : "EVM gas price"}
          </p>
        </div>

        <div className="vq-glass p-4" data-testid="metric-ledger">
          <p className="text-xs font-medium uppercase tracking-wide text-vault-muted">
            {isStellar ? "Source ledger" : "Chain ID"}
          </p>
          <p className="mt-1 text-lg font-semibold text-vault-text truncate">
            {isStellar
              ? feeData.sourceLedger
                ? `#${feeData.sourceLedger}`
                : "Fallback ledger"
              : "43114"}
          </p>
          <p className="mt-1 text-xs text-vault-muted">
            {isStellar ? (feeData.sourceLedger ? "Verified on-chain" : "Default baseline") : "Avalanche"}
          </p>
        </div>

        <div className="vq-glass p-4" data-testid="metric-freshness">
          <p className="text-xs font-medium uppercase tracking-wide text-vault-muted">
            Freshness
          </p>
          <p className="mt-1 text-lg font-semibold text-vault-text flex items-center gap-1.5">
            {isStale ? (
              <span className="text-amber-500 dark:text-amber-400">Stale data</span>
            ) : (
              <span className="text-emerald-500 dark:text-emerald-400">Live rate</span>
            )}
          </p>
          <p className="mt-1 text-xs text-vault-muted truncate">
            {updatedAt ? `Updated ${updatedAt.toLocaleTimeString()}` : "Not updated"}
          </p>
        </div>

        <div
          className={`vq-glass p-4 ${hasEnoughBalance ? "" : "border-amber-400/30 bg-amber-500/10"}`}
          data-testid="metric-balance"
        >
          <p className="text-xs font-medium uppercase tracking-wide text-vault-muted">
            Balance check
          </p>
          <p
            className={`mt-1 text-lg font-semibold ${
              hasEnoughBalance ? "text-emerald-500 dark:text-emerald-400" : "text-amber-500 dark:text-amber-400"
            }`}
          >
            {hasEnoughBalance ? "Ready to send" : "Fee balance low"}
          </p>
          <p className="mt-1 text-xs text-vault-muted">
            Wallet: {formatToken(nativeBalanceValue, nativeToken)}
          </p>
        </div>
      </div>

      {/* Warnings & Alerts */}
      {(error || isStale || !hasEnoughBalance) && !isUnsupported && (
        <div
          role="alert"
          aria-live="assertive"
          data-testid="fee-warning-alert"
          className={`mt-5 flex items-start gap-3 rounded-2xl border p-4 text-sm ${
            error || isStale
              ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
              : "border-amber-400/35 bg-amber-500/10 text-amber-100"
          }`}
        >
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" aria-hidden="true" />
          <div>
            <p className="font-semibold text-vault-text">
              {error ? "Network Warning" : isStale ? "Stale Fee Notice" : "Insufficient Balance"}
            </p>
            <p className="mt-1 text-vault-muted">
              {error
                ? `${error}. Using fallback fee stats (${STELLAR_CONFIG.fallbackBaseFee} stroops).`
                : isStale
                ? "Fee stats could not be refreshed from live ledger. Using baseline fallback fee."
                : `Your wallet balance (${formatToken(nativeBalanceValue, nativeToken)}) is below the estimated fee for the ${tier.label.toLowerCase()} priority tier.`}
            </p>
          </div>
        </div>
      )}

      {/* Execution Payload Section */}
      <div className="mt-5 grid gap-3 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-2xl border border-vault-border/50 bg-vault-surface/25 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-vault-text">
            <Activity className="h-4 w-4 text-red-500" aria-hidden="true" />
            Execution payload
          </div>
          <pre
            className="mt-3 overflow-auto rounded-xl bg-slate-950/80 p-4 text-xs leading-relaxed text-slate-200"
            data-testid="execution-payload-preview"
          >
            {JSON.stringify(
              {
                network: isStellar ? "Stellar" : "Avalanche",
                priority: tier.label,
                estimatedNative: formatToken(feeSummary.estimatedNative, nativeToken),
                estimatedUsd: formatUsd(feeSummary.estimatedUsd),
                payload: feeSummary.payload,
              },
              null,
              2
            )}
          </pre>
        </div>

        <div className="rounded-2xl border border-vault-border/50 bg-vault-surface/25 p-4">
          <p className="text-sm font-semibold text-vault-text">Live status</p>
          <p className="mt-2 text-sm text-vault-muted">
            {updatedAt
              ? `Updated ${updatedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
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