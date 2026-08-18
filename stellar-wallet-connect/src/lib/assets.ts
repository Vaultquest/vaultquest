/**
 * Asset registry for network-specific asset configurations.
 * 
 * Defines canonical asset identities per network to prevent
 * cross-network asset confusion and hard-coded issuers.
 */

import type { NetworkType } from "./wallets.js";

/**
 * Asset configuration for a specific asset on a specific network
 */
export interface AssetConfig {
  /** Asset code (e.g., "USDC", "XLM") */
  code: string;
  /** Issuer public key for the asset on this network */
  issuer: string;
  /** Number of decimal places for the asset */
  decimals: number;
  /** Human-readable name */
  name: string;
  /** Optional icon URL */
  icon?: string;
}

/**
 * Asset registry mapped by network and asset code
 */
export type AssetRegistry = Record<NetworkType, Record<string, AssetConfig>>;

/**
 * Canonical asset registry for all supported networks
 * 
 * Each network has its own set of supported assets with their
 * correct issuer addresses and decimal places.
 */
export const ASSET_REGISTRY: AssetRegistry = {
  mainnet: {
    USDC: {
      code: "USDC",
      issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      decimals: 7,
      name: "USD Coin",
      icon: "https://stellar.quest/icon/usdc.svg",
    },
  },
  testnet: {
    USDC: {
      code: "USDC",
      issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      decimals: 7,
      name: "USD Coin (Testnet)",
      icon: "https://stellar.quest/icon/usdc.svg",
    },
  },
  futurenet: {
    USDC: {
      code: "USDC",
      issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      decimals: 7,
      name: "USD Coin (Futurenet)",
      icon: "https://stellar.quest/icon/usdc.svg",
    },
  },
  standalone: {
    USDC: {
      code: "USDC",
      issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      decimals: 7,
      name: "USD Coin (Standalone)",
      icon: "https://stellar.quest/icon/usdc.svg",
    },
  },
};

/**
 * Get asset configuration for a specific network and asset code.
 * 
 * @param network - The network type (mainnet, testnet, etc.)
 * @param assetCode - The asset code (e.g., "USDC")
 * @returns The asset configuration or undefined if not found
 */
export function getAssetConfig(
  network: NetworkType,
  assetCode: string
): AssetConfig | undefined {
  return ASSET_REGISTRY[network]?.[assetCode];
}

/**
 * Check if an asset is supported on a given network.
 * 
 * @param network - The network type
 * @param assetCode - The asset code to check
 * @returns True if the asset is supported on the network
 */
export function isAssetSupported(network: NetworkType, assetCode: string): boolean {
  return !!getAssetConfig(network, assetCode);
}

/**
 * Get the canonical issuer for an asset on a specific network.
 * 
 * @param network - The network type
 * @param assetCode - The asset code
 * @returns The issuer public key, or null if asset is native XLM
 */
export function getAssetIssuer(network: NetworkType, assetCode: string): string | null {
  if (assetCode === "XLM") return null;
  const config = getAssetConfig(network, assetCode);
  return config?.issuer || null;
}

/**
 * Get the decimal places for an asset on a specific network.
 * 
 * @param network - The network type
 * @param assetCode - The asset code
 * @returns The number of decimal places, or 7 for unknown assets
 */
export function getAssetDecimals(network: NetworkType, assetCode: string): number {
  if (assetCode === "XLM") return 7;
  const config = getAssetConfig(network, assetCode);
  return config?.decimals ?? 7;
}

/**
 * Validate that a balance matches the canonical asset for the network.
 * 
 * @param network - The network type
 * @param assetCode - The asset code from the balance
 * @param issuer - The issuer from the balance
 * @returns True if the balance represents a canonical asset
 */
export function isValidCanonicalAsset(
  network: NetworkType,
  assetCode: string,
  issuer: string | null
): boolean {
  if (assetCode === "XLM" && !issuer) return true;
  const config = getAssetConfig(network, assetCode);
  if (!config) return false;
  return config.issuer === issuer;
}

/**
 * Get all supported assets for a network.
 * 
 * @param network - The network type
 * @returns Array of asset codes supported on the network
 */
export function getSupportedAssets(network: NetworkType): string[] {
  return Object.keys(ASSET_REGISTRY[network] || {});
}
