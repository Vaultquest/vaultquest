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

const NATIVE_ASSET_ISSUER = "native";

/**
 * Zero balances for an unresolved/unavailable account. `usdcIssuer` is
 * optional because it depends on the network-specific asset registry
 * (issue #104); when the network hasn't been resolved yet (e.g. an early
 * exit before Horizon replies) there is no issuer to attach.
 */
function zeroWalletBalances(usdcIssuer: string = ""): { XLM: AssetAmount; USDC: AssetAmount } {
  return {
    XLM: zeroAssetAmount("XLM", NATIVE_ASSET_ISSUER),
    USDC: zeroAssetAmount("USDC", usdcIssuer),
  };
}

/**
 * Check if the connected wallet exists and has funds.
 *
 * Balances are exact (issue #106): Horizon already serialises them as
 * decimal strings with up to 7 fractional digits, so they are kept as
 * validated decimal strings / integer minor units instead of being coerced
 * through `Number(...)`, which can silently lose precision on large values
 * or the low-order digits of a 7-decimal amount. Asset code/issuer/decimals
 * stay attached to every amount rather than being implied by field name.
 */
async function getWalletHealth(): Promise<{
  exists: boolean;
  balances: { XLM: AssetAmount; USDC: AssetAmount };
}> {
  const publicKey = loadedPublicKey();

  if (!publicKey) return { exists: false, balances: zeroWalletBalances() };

  try {
    // Route through the connection pool: distributes the lookup across the
    // configured Horizon nodes and retries on rate limits / node failures.
    const resp = await getHorizonPool().request(`/accounts/${publicKey}`, {
      headers: { Accept: "application/json" },
    });

    if (resp.status === 404) {
      return { exists: false, balances: zeroWalletBalances() };
    }

    if (!resp.ok) {
      return { exists: false, balances: zeroWalletBalances() };
    }

    const json = await resp.json();
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
      return { exists: true, balances: { XLM: xlm, USDC: zeroAssetAmount("USDC", "") } };
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

    return { exists: true, balances: { XLM: xlm, USDC: usdc } };
  } catch (error) {
    console.error("Error checking wallet health:", error);
    return { exists: false, balances: zeroWalletBalances() };
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
