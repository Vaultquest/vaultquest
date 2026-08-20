import { connectedPublicKey, connectedNetwork, isNetworkMismatch, networkReadiness } from "./store.js";
import { kit } from "./kit.js";
import type { ISupportedWallet } from "@creit.tech/stellar-wallets-kit";
import {
  EXPECTED_NETWORK,
  type NetworkType,
  type WalletType,
  normalizeStellarNetwork,
} from "../lib/wallets.js";
import { HorizonPool } from "./horizonPool.js";
import { assetAmountFrom, zeroAssetAmount, type AssetAmount } from "./amount.js";
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

/**
 * Monotonically increasing token identifying the "current" connection.
 * Any in-flight network verification captures the token at the time it was
 * started; when it resolves, it only applies the result if the token is
 * still current. This prevents a stale verification (from a connection that
 * has since been replaced or torn down) from overwriting fresher state -
 * e.g. a slow verification racing a network switch or a disconnect.
 */
let connectionGeneration = 0;

function verifyNetworkInBackground(generation: number): void {
  networkReadiness.set("verifying");
  isNetworkMismatch.set(false);

  // Uses queryConnectedNetwork (not getConnectedNetwork) so a provider
  // failure surfaces as a distinct "error" state instead of being silently
  // treated as a match against EXPECTED_NETWORK.
  queryConnectedNetwork()
    .then((net) => {
      if (generation !== connectionGeneration) return; // stale, ignore
      connectedNetwork.set(net);
      const mismatch = net !== EXPECTED_NETWORK;
      isNetworkMismatch.set(mismatch);
      networkReadiness.set(mismatch ? "mismatch" : "verified");
    })
    .catch(() => {
      if (generation !== connectionGeneration) return; // stale, ignore
      // Verification failed (provider error) - this is distinct from a
      // confirmed mismatch and must NOT be treated as "ready".
      connectedNetwork.set(null);
      isNetworkMismatch.set(true);
      networkReadiness.set("error");
    });
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

  // Invalidate any previous in-flight verification and start a fresh one.
  // Contract actions must stay gated (networkReadiness !== "verified")
  // until this resolves.
  const generation = ++connectionGeneration;
  verifyNetworkInBackground(generation);
}

function disconnect(): void {
  connectionState.publicKey = undefined;
  connectionState.provider = undefined;

  if (typeof localStorage !== "undefined") {
    localStorage.removeItem("publicKey");
    localStorage.removeItem("walletProvider");
  }

  // Invalidate any in-flight verification so it cannot resurrect stale state.
  ++connectionGeneration;

  connectedPublicKey.set("");
  connectedNetwork.set(null);
  isNetworkMismatch.set(false);
  networkReadiness.set("idle");
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

/**
 * Queries the wallet provider for its connected network and rethrows on
 * failure - callers that need to distinguish a confirmed network from a
 * verification outage (issue #101) must use this instead of
 * {@link getConnectedNetwork}, which intentionally swallows errors for
 * call sites that only want a best-effort default.
 */
async function queryConnectedNetwork(): Promise<NetworkType> {
  const networkResult = await kit.getNetwork();
  return (
    normalizeStellarNetwork(networkResult?.network) ||
    normalizeStellarNetwork(networkResult?.networkPassphrase) ||
    EXPECTED_NETWORK
  );
}

async function getConnectedNetwork(): Promise<NetworkType> {
  try {
    return await queryConnectedNetwork();
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

    // Verify network in the background. Actions stay gated
    // (networkReadiness !== "verified") until this resolves.
    const generation = ++connectionGeneration;
    verifyNetworkInBackground(generation);

    return {
      publicKey: storedPublicKey,
      provider: appProvider,
    };
  }

  return null;
}

const NATIVE_ASSET_ISSUER = "native";

/**
 * Discriminated wallet-health outcome (issue #103). Only "ready" carries
 * trustworthy balances; every other status means the Horizon lookup did NOT
 * confirm the account is unfunded/nonexistent, and callers MUST NOT treat it
 * as zero funds. "not-found" is reserved for an authoritative 404 - any
 * other non-OK response, thrown exception, or malformed body is an
 * *operational* problem with the provider, not a fact about the account.
 *
 * Balances are exact (issue #106): Horizon already serialises them as
 * decimal strings with up to 7 fractional digits, so they are kept as
 * validated decimal strings / integer minor units instead of being coerced
 * through `Number(...)`, which can silently lose precision on large values
 * or the low-order digits of a 7-decimal amount. Asset code/issuer/decimals
 * stay attached to every amount rather than being implied by field name.
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
  /** Present only when `status` is "ready" (or a stale "ready" fallback). */
  balances: { XLM: AssetAmount; USDC: AssetAmount } | null;
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
const lastKnownGood = new Map<
  string,
  { balances: { XLM: AssetAmount; USDC: AssetAmount }; asOfMs: number }
>();

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
    const rawBalances: any[] = json.balances || [];

    // Fetch XLM (native). If Horizon ever returns something that doesn't
    // parse as a valid 7-decimal Stellar amount, fall back to zero but log
    // it - that's a data/provider problem, not evidence of an empty wallet.
    const native = rawBalances.find((b: any) => b.asset_type === "native");
    let xlm = zeroAssetAmount("XLM", NATIVE_ASSET_ISSUER);
    if (native) {
      const parsed = assetAmountFrom("XLM", NATIVE_ASSET_ISSUER, String(native.balance));
      if (parsed) {
        xlm = parsed;
      } else {
        console.error("Unparseable XLM balance from Horizon:", native.balance);
      }
    }

    // Fetch USDC using the network-specific asset registry (issue #104),
    // parsed as an exact AssetAmount (issue #106) - never through Number().
    const network = await getConnectedNetwork();
    const usdcIssuer = getAssetIssuer(network, "USDC");

    // USDC not supported on this network: report an exact zero rather than
    // guessing/hardcoding an issuer.
    if (!usdcIssuer) {
      const balances = { XLM: xlm, USDC: zeroAssetAmount("USDC", "") };
      const asOfMs = Date.now();
      lastKnownGood.set(publicKey, { balances, asOfMs });
      return { status: "ready", exists: true, balances, stale: false, asOfMs };
    }

    const usdcRaw = rawBalances.find(
      (b: any) => b.asset_code === "USDC" && b.issuer === usdcIssuer,
    );
    let usdc = zeroAssetAmount("USDC", usdcIssuer);
    if (usdcRaw) {
      const parsed = assetAmountFrom("USDC", usdcIssuer, String(usdcRaw.balance));
      if (parsed) {
        usdc = parsed;
      } else {
        console.error("Unparseable USDC balance from Horizon:", usdcRaw.balance);
      }
    }

    const balances = { XLM: xlm, USDC: usdc };
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
