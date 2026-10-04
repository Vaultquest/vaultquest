/**
 * Chain fee adapters — isolate Stellar (stroops / Horizon) from Avalanche (wei / EVM).
 * Vault deposit/withdraw paths must use the Stellar adapter only.
 * Avalanche remains available for a future independently routed product (non-goal of #123).
 */

import { DEFAULT_RPC, getHorizonUrl } from "@/lib/customRpc";

export const FEE_STALE_AFTER_MS = 60_000;

export const STELLAR_NETWORKS = {
  testnet: {
    key: "testnet",
    label: "Stellar Testnet",
    horizon: "https://horizon-testnet.stellar.org",
    explorerTx: (hash) => `https://stellar.expert/explorer/testnet/tx/${hash}`,
  },
  mainnet: {
    key: "mainnet",
    label: "Stellar Mainnet",
    horizon: "https://horizon.stellar.org",
    explorerTx: (hash) => `https://stellar.expert/explorer/public/tx/${hash}`,
  },
};

export const STELLAR_FEE_CONFIG = {
  key: "stellar",
  label: "Stellar",
  nativeToken: "XLM",
  usdRate: 0.13,
  fallbackBaseFeeStroops: 100,
  minBaseFeeStroops: 100,
  stroopsPerToken: 1e7,
};

export const AVALANCHE_FEE_CONFIG = {
  key: "avalanche",
  label: "Avalanche C-Chain",
  nativeToken: "AVAX",
  usdRate: 36,
  gasLimit: 180000n,
  fallbackGasPriceWei: 25_000_000_000n,
  weiPerToken: 1e18,
};

/**
 * Resolve which Horizon base URL to query for fee_stats.
 * Priority: explicit customHorizonUrl → stored custom RPC → network default.
 */
export function resolveStellarHorizonUrl({
  networkType = "testnet",
  customHorizonUrl,
  storedHorizonUrl,
} = {}) {
  if (typeof customHorizonUrl === "string" && customHorizonUrl.trim()) {
    return customHorizonUrl.trim().replace(/\/+$/, "");
  }
  if (typeof storedHorizonUrl === "string" && storedHorizonUrl.trim()) {
    const stored = storedHorizonUrl.trim().replace(/\/+$/, "");
    if (stored !== DEFAULT_RPC.horizon.replace(/\/+$/, "")) {
      return stored;
    }
  }
  const network = STELLAR_NETWORKS[networkType] ?? STELLAR_NETWORKS.testnet;
  return network.horizon.replace(/\/+$/, "");
}

/** Active Horizon from localStorage (or default), for browser contexts. */
export function resolveActiveHorizonUrl(networkType = "testnet", customHorizonUrl) {
  let stored;
  try {
    stored = getHorizonUrl();
  } catch {
    stored = undefined;
  }
  return resolveStellarHorizonUrl({
    networkType,
    customHorizonUrl,
    storedHorizonUrl: stored,
  });
}

/**
 * Fetch Stellar fee stats from Horizon. An optional signal cancels obsolete reads.
 * @returns {Promise<{
 *   baseFeeStroops: number,
 *   sourceLedger: string | null,
 *   horizonUrl: string,
 *   fetchedAt: Date,
 *   fresh: boolean,
 * }>}
 */
export async function fetchStellarFeeStats({
  networkType = "testnet",
  customHorizonUrl,
  signal,
  fetchImpl = fetch,
} = {}) {
  const horizonUrl = resolveActiveHorizonUrl(networkType, customHorizonUrl);
  const endpoint = `${horizonUrl}/fee_stats`;
  const response = await fetchImpl(endpoint, {
    headers: { accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`Horizon fee_stats HTTP ${response.status}`);
  }
  const data = await response.json();
  // A fallback is not a live observation. Reject malformed fields so the
  // caller's existing failure path keeps fallback pricing visibly stale.
  const baseFeeStroops = positiveFeeStatsInteger(data?.last_ledger_base_fee);
  const ledger = positiveFeeStatsInteger(data?.last_ledger);
  if (baseFeeStroops === null || ledger === null) {
    throw new Error("Invalid Horizon fee_stats base fee or source ledger");
  }
  const sourceLedger = String(ledger);

  return {
    baseFeeStroops,
    sourceLedger,
    horizonUrl,
    fetchedAt: new Date(),
    fresh: Boolean(sourceLedger),
  };
}

// Horizon fields may be JSON numbers or decimal strings; JavaScript coercion
// must not turn booleans, arrays, fractions, or rounded integers into evidence.
function positiveFeeStatsInteger(value) {
  if (typeof value !== "number" &&
      (typeof value !== "string" || !/^[1-9]\d*$/.test(value))) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function stellarFeeObservationTime(fetchedAt, now) {
  const timestamp = fetchedAt ? new Date(fetchedAt).getTime() : NaN;
  const validTimestamp = Number.isFinite(timestamp);
  return {
    freshness: validTimestamp ? new Date(timestamp).toISOString() : null,
    ageMs: validTimestamp && Number.isFinite(now) && timestamp <= now
      ? now - timestamp
      : null,
  };
}

/**
 * Build a Stellar fee estimate from base fee + optional Soroban simulation resource fee.
 */
export function buildStellarFeeEstimate({
  baseFeeStroops = STELLAR_FEE_CONFIG.fallbackBaseFeeStroops,
  simulationResourceFee = 0,
  multiplier = 1,
  sourceLedger = null,
  fetchedAt = null,
  networkType = "testnet",
  horizonUrl = null,
  priorityKey = "medium",
  isUnsupported = false,
  now = Date.now(),
} = {}) {
  const base = Math.max(
    STELLAR_FEE_CONFIG.minBaseFeeStroops,
    Math.round(Number(baseFeeStroops) * multiplier),
  );
  const resourceFeeStroops = Math.max(0, Math.round(Number(simulationResourceFee) || 0));
  const feeStroops = base + resourceFeeStroops;
  const estimatedNative = feeStroops / STELLAR_FEE_CONFIG.stroopsPerToken;
  const { ageMs, freshness } = stellarFeeObservationTime(fetchedAt, now);
  const isStale =
    isUnsupported ||
    !sourceLedger ||
    ageMs == null ||
    ageMs >= FEE_STALE_AFTER_MS;

  return {
    type: "stellar",
    chain: STELLAR_FEE_CONFIG.label,
    network: networkType,
    priority: priorityKey,
    nativeToken: STELLAR_FEE_CONFIG.nativeToken,
    baseFeeStroops: base,
    resourceFeeStroops,
    feeStroops,
    feeBid: `${(feeStroops / STELLAR_FEE_CONFIG.stroopsPerToken).toFixed(7)} ${STELLAR_FEE_CONFIG.nativeToken}`,
    estimatedNative,
    estimatedUsd: estimatedNative * STELLAR_FEE_CONFIG.usdRate,
    sourceLedger: sourceLedger ?? "fallback",
    horizonUrl,
    freshness,
    ageMs,
    isStale,
    unsupported: Boolean(isUnsupported),
  };
}

/**
 * Fetch Avalanche C-Chain gas price (kept for independently routed Avalanche product).
 * Not used by Stellar deposit/withdraw paths.
 */
export async function fetchAvalancheGasPrice({ fetchImpl = fetch } = {}) {
  const response = await fetchImpl("https://api.avax.network/ext/bc/C/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_gasPrice",
      params: [],
    }),
  });
  if (!response.ok) {
    throw new Error("Unable to fetch Avalanche gas price");
  }
  const data = await response.json();
  const gasPrice =
    typeof data?.result === "string" ? BigInt(data.result) : null;
  return {
    gasPriceWei: gasPrice ?? AVALANCHE_FEE_CONFIG.fallbackGasPriceWei,
    fetchedAt: new Date(),
  };
}

export function buildAvalancheFeeEstimate({
  gasPriceWei = AVALANCHE_FEE_CONFIG.fallbackGasPriceWei,
  multiplier = 1,
  priorityKey = "medium",
  fetchedAt = null,
  isUnsupported = false,
} = {}) {
  const adjusted = BigInt(
    Math.max(1, Math.round(Number(gasPriceWei) * multiplier)),
  );
  const maxPriorityFeePerGas = BigInt(
    Math.max(1, Math.round(Number(gasPriceWei) * 0.12 * multiplier)),
  );
  const estimatedNative =
    Number(adjusted * AVALANCHE_FEE_CONFIG.gasLimit) /
    AVALANCHE_FEE_CONFIG.weiPerToken;

  return {
    type: "evm",
    chain: AVALANCHE_FEE_CONFIG.label,
    priority: priorityKey,
    nativeToken: AVALANCHE_FEE_CONFIG.nativeToken,
    gasLimit: AVALANCHE_FEE_CONFIG.gasLimit.toString(),
    maxFeePerGas: adjusted.toString(),
    maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
    gasPriceWei: adjusted.toString(),
    estimatedNative,
    estimatedUsd: estimatedNative * AVALANCHE_FEE_CONFIG.usdRate,
    freshness: fetchedAt ? new Date(fetchedAt).toISOString() : null,
    unsupported: Boolean(isUnsupported),
  };
}

export function classifyFeeFreshness({
  fetchedAt,
  sourceLedger,
  isUnsupported = false,
  now = Date.now(),
  staleAfterMs = FEE_STALE_AFTER_MS,
} = {}) {
  if (isUnsupported) return "unsupported";
  if (!fetchedAt || !sourceLedger) return "stale";
  const { ageMs } = stellarFeeObservationTime(fetchedAt, now);
  if (ageMs === null || ageMs >= staleAfterMs) return "stale";
  return "fresh";
}
