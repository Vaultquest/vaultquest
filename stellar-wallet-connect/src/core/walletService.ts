import { getAssetIssuer, isValidCanonicalAsset, getAssetConfig } from "../lib/assets";
import { connectedPublicKey, connectedNetwork, isNetworkMismatch } from "./store.js";
import { kit } from "./kit.js";
import type { ISupportedWallet } from "@creit.tech/stellar-wallets-kit";
import {
  EXPECTED_NETWORK,
  type NetworkType,
  type WalletType,
  normalizeStellarNetwork,
} from "../lib/wallets.js";
import { HorizonPool } from "./horizonPool.js";
import { getAssetIssuer, isValidCanonicalAsset } from "../lib/assets.js";
export interface WalletConnectionResult {
  address: string;
  publicKey: string;
  network: NetworkType;
  provider: WalletType;
  kitWalletId: string;
}

export interface StoredWalletConnection {
  publicKey: string;
  provider: WalletType;
}

const connectionState: {
  publicKey: string | undefined;
  provider: WalletType | undefined;
} = {
  publicKey: undefined,
  provider: undefined,
};

const walletKitIds: Record<WalletType, string> = {
  freighter: "freighter",
  albedo: "albedo",
  xbull: "xbull",
  rabet: "rabet",
  ledger: "LEDGER",
};

const appWalletTypesByKitId: Record<string, WalletType> = {
  freighter: "freighter",
  albedo: "albedo",
  xbull: "xbull",
  rabet: "rabet",
  LEDGER: "ledger",
  ledger: "ledger",
};

/**
 * Lazily-initialised Horizon connection pool (#rate-limits). Balances on-chain
 * read traffic across the configured public/private nodes, routes to the
 * healthiest endpoint, and retries rate-limited requests with backoff.
 */
let _horizonPool: HorizonPool | undefined;

function getHorizonPool(): HorizonPool {
  if (!_horizonPool) {
    _horizonPool = new HorizonPool({ nodes: resolveHorizonNodes() });
  }
  return _horizonPool;
}

/** Test/SSR seam to inject or reset the pool. */
function setHorizonPool(pool: HorizonPool | undefined): void {
  _horizonPool = pool;
}

function loadedPublicKey(): string | undefined {
  return connectionState.publicKey;
}

function loadedProvider(): WalletType | undefined {
  return connectionState.provider;
}

function toKitWalletId(provider: string): string {
  return walletKitIds[provider as WalletType] || provider;
}

function toAppWalletType(provider: string): WalletType | undefined {
  return appWalletTypesByKitId[provider];
}

function setConnection(publicKey: string, provider: string): void {
  const appProvider = toAppWalletType(provider);

  if (!appProvider) {
    throw new Error(`Unsupported Stellar wallet provider: ${provider}`);
  }

  connectionState.publicKey = publicKey;
  connectionState.provider = appProvider;

  if (typeof localStorage !== "undefined") {
    localStorage.setItem("publicKey", publicKey);
    localStorage.setItem("walletProvider", appProvider);
  }

  connectedPublicKey.set(publicKey);

  // Set the network in the background and check for mismatch
  getConnectedNetwork().then((net) => {
    connectedNetwork.set(net);
    isNetworkMismatch.set(net !== EXPECTED_NETWORK);
  }).catch(() => {
    connectedNetwork.set(EXPECTED_NETWORK);
    isNetworkMismatch.set(false);
  });
}

function disconnect(): void {
  connectionState.publicKey = undefined;
  connectionState.provider = undefined;

  if (typeof localStorage !== "undefined") {
    localStorage.removeItem("publicKey");
    localStorage.removeItem("walletProvider");
  }

  connectedPublicKey.set("");
  connectedNetwork.set(null);
  isNetworkMismatch.set(false);
}

export async function checkAndNotifyFunding(): Promise<void> {
  // The product flow no longer opens the wallet funding modal automatically.
  return;
}

async function getWalletAvailability(provider: WalletType): Promise<{
  wallet: ISupportedWallet | undefined;
  isAvailable: boolean;
}> {
  if (typeof window === "undefined") {
    return { wallet: undefined, isAvailable: false };
  }

  const kitWalletId = toKitWalletId(provider);
  const supportedWallets = await kit.getSupportedWallets();
  const wallet = supportedWallets.find((option) => option.id === kitWalletId);

  return {
    wallet,
    isAvailable: Boolean(wallet?.isAvailable || wallet?.isPlatformWrapper),
  };
}

async function connectWallet(provider: WalletType): Promise<WalletConnectionResult> {
  if (typeof window === "undefined") {
    throw new Error("Wallet connection is only available in the browser");
  }

  const kitWalletId = toKitWalletId(provider);
  const { isAvailable } = await getWalletAvailability(provider);

  if (!isAvailable && provider !== "albedo") {
    throw new Error("Wallet not installed or unavailable");
  }

  kit.setWallet(kitWalletId);

  const { address } = await kit.getAddress(
    provider === "freighter" ? { skipRequestAccess: false } : undefined,
  );

  const network = await getConnectedNetwork();

  setConnection(address, provider);

  return {
    address,
    publicKey: address,
    network,
    provider,
    kitWalletId,
  };
}

async function disconnectWallet(provider?: WalletType): Promise<void> {
  try {
    if (provider && typeof window !== "undefined") {
      kit.setWallet(toKitWalletId(provider));
      await kit.disconnect();
    }
  } finally {
    disconnect();
  }
}

async function getConnectedNetwork(): Promise<NetworkType> {
  try {
    const networkResult = await kit.getNetwork();
    return (
      normalizeStellarNetwork(networkResult?.network) ||
      normalizeStellarNetwork(networkResult?.networkPassphrase) ||
      EXPECTED_NETWORK
    );
  } catch {
    return EXPECTED_NETWORK;
  }
}

function initializeConnection(): StoredWalletConnection | null {
  if (typeof localStorage === "undefined") return null;

  const storedPublicKey = localStorage.getItem("publicKey");
  const storedProvider = localStorage.getItem("walletProvider");
  const appProvider = storedProvider ? toAppWalletType(storedProvider) : undefined;

  if (storedPublicKey && appProvider) {
    connectionState.publicKey = storedPublicKey;
    connectionState.provider = appProvider;
    connectedPublicKey.set(storedPublicKey);

    // Verify network and mismatch in the background
    getConnectedNetwork().then((net) => {
      connectedNetwork.set(net);
      isNetworkMismatch.set(net !== EXPECTED_NETWORK);
    }).catch(() => {
      connectedNetwork.set(EXPECTED_NETWORK);
      isNetworkMismatch.set(false);
    });

    return {
      publicKey: storedPublicKey,
      provider: appProvider,
    };
  }

  return null;
}

/**
 * Discriminated wallet-health outcome (issue #103). Only "ready" carries
 * trustworthy balances; every other status means the Horizon lookup did NOT
 * confirm the account is unfunded/nonexistent, and callers MUST NOT treat it
 * as zero funds. "not-found" is reserved for an authoritative 404 - any
 * other non-OK response, thrown exception, or malformed body is an
 * *operational* problem with the provider, not a fact about the account.
 */
export type WalletHealthStatus =
  | "ready"
  | "not-found"
  | "unavailable"
  | "rate-limited"
  | "invalid-response";

export interface WalletHealthResult {
  status: WalletHealthStatus;
  /** True only when `status` is "ready" (or a stale "ready" fallback). */
  exists: boolean;
  /** Present only when `status` is "ready". */
  balances: { XLM: number; USDC: number } | null;
  /**
   * Set when this result is last-known-good data served during an outage
   * instead of a fresh lookup. Always paired with `asOfMs` so callers can
   * judge freshness before acting on it.
   */
  stale: boolean;
  /** Timestamp (ms) the balances were last confirmed fresh from Horizon. */
  asOfMs: number | null;
  /** Diagnostic detail for non-"ready" statuses; never used for control flow. */
  detail?: string;
}

const READY_NONE: WalletHealthResult = {
  status: "ready",
  exists: false,
  balances: null,
  stale: false,
  asOfMs: null,
};

/** Per-publicKey last-known-good snapshot, used only as an explicit stale fallback during outages. */
const lastKnownGood = new Map<string, { balances: { XLM: number; USDC: number }; asOfMs: number }>();

function staleFallback(publicKey: string, status: WalletHealthStatus, detail: string): WalletHealthResult {
  const cached = lastKnownGood.get(publicKey);
  if (cached) {
    return {
      status,
      exists: true,
      balances: cached.balances,
      stale: true,
      asOfMs: cached.asOfMs,
      detail,
    };
  }
  return { status, exists: false, balances: null, stale: false, asOfMs: null, detail };
}

/**
 * Check whether the connected wallet exists and has funds, distinguishing a
 * confirmed missing/unfunded account from a Horizon outage (issue #103).
 * A non-"ready" status is never zero balances - it's "we don't know".
 */
async function getWalletHealth(): Promise<WalletHealthResult> {
  const publicKey = loadedPublicKey();

  if (!publicKey) return READY_NONE;

  try {
    // Route through the connection pool: distributes the lookup across the
    // configured Horizon nodes and retries on rate limits / node failures.
    const resp = await getHorizonPool().request(`/accounts/${publicKey}`, {
      headers: { Accept: "application/json" },
    });

    // Only an authoritative 404 means the account is confirmed missing.
    if (resp.status === 404) {
      return { status: "not-found", exists: false, balances: null, stale: false, asOfMs: null };
    }

    if (resp.status === 429) {
      return staleFallback(publicKey, "rate-limited", "Horizon rate limit (429)");
    }

    if (!resp.ok) {
      // 5xx / other non-OK: an operational error, never "unfunded".
      return staleFallback(publicKey, "unavailable", `Horizon returned HTTP ${resp.status}`);
    }

    let json: any;
    try {
      json = await resp.json();
    } catch (parseError) {
      return staleFallback(publicKey, "invalid-response", "Horizon response was not valid JSON");
    }

    // Fetch XLM (native)
    const native = (json.balances || []).find(
      (b: any) => b.asset_type === "native",
    );
    const xlmBalance = native ? Number(native.balance) : 0;

    // Fetch USDC using network-specific asset registry
    const network = await getConnectedNetwork();
    const usdcIssuer = getAssetIssuer(network, "USDC");
    
    // Check if USDC is supported on this network
    if (!usdcIssuer) {
      // USDC not supported on this network
      const balances = { XLM: xlmBalance, USDC: 0 };
      const asOfMs = Date.now();
      lastKnownGood.set(publicKey, { balances, asOfMs });
      return { status: "ready", exists: true, balances, stale: false, asOfMs };
    }

    const usdc = (json.balances || []).find(
      (b: any) => b.asset_code === "USDC" && b.issuer === usdcIssuer,
    );
    const usdcBalance = usdc ? Number(usdc.balance) : 0;

    const balances = { XLM: xlmBalance, USDC: usdcBalance };
    const asOfMs = Date.now();
    lastKnownGood.set(publicKey, { balances, asOfMs });

    return { status: "ready", exists: true, balances, stale: false, asOfMs };
  } catch (error) {
    // Network-level failure (timeout, DNS, connection reset, etc.) - an
    // outage, not evidence the account is unfunded/nonexistent.
    console.error("Error checking wallet health:", error);
    return staleFallback(publicKey, "unavailable", error instanceof Error ? error.message : String(error));
  }
}

export {
  loadedPublicKey,
  loadedProvider,
  toKitWalletId,
  toAppWalletType,
  getWalletAvailability,
  connectWallet,
  disconnectWallet,
  getConnectedNetwork,
  setConnection,
  disconnect,
  initializeConnection,
  getWalletHealth,
  getHorizonPool,
  setHorizonPool,
};
