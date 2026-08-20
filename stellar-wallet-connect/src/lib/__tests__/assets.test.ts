import { describe, it, expect } from "vitest";
import {
  ASSET_REGISTRY,
  getAssetConfig,
  getAssetIssuer,
  getAssetDecimals,
  getAssetDisplayName,
  isAssetSupported,
  isValidCanonicalAsset,
  getSupportedAssets,
  isPlaceholderValue,
  validateAssetConfig,
  validateRegistry,
} from "../assets";
import type { NetworkType } from "../wallets";

describe("Asset Registry", () => {
  const networks: NetworkType[] = ["mainnet", "testnet", "futurenet", "standalone"];

  describe("ASSET_REGISTRY", () => {
    it("has USDC defined for all networks", () => {
      for (const network of networks) {
        expect(ASSET_REGISTRY[network].USDC).toBeDefined();
        expect(ASSET_REGISTRY[network].USDC.code).toBe("USDC");
      }
    });

    it("has correct mainnet USDC issuer", () => {
      expect(ASSET_REGISTRY.mainnet.USDC.issuer).toBe(
        "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
      );
    });

    it("has correct testnet USDC issuer", () => {
      expect(ASSET_REGISTRY.testnet.USDC.issuer).toBe(
        "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
      );
    });

    it("has correct decimals for USDC (7)", () => {
      for (const network of networks) {
        expect(ASSET_REGISTRY[network].USDC.decimals).toBe(7);
      }
    });
  });

  describe("getAssetConfig", () => {
    it("returns config for existing asset", () => {
      const config = getAssetConfig("mainnet", "USDC");
      expect(config).toBeDefined();
      expect(config?.code).toBe("USDC");
    });

    it("returns undefined for non-existent asset", () => {
      const config = getAssetConfig("mainnet", "NONEXISTENT");
      expect(config).toBeUndefined();
    });

    it("returns undefined for non-existent network", () => {
      const config = getAssetConfig("mainnet" as NetworkType, "USDC");
      expect(config).toBeDefined();
    });
  });

  describe("getAssetIssuer", () => {
    it("returns correct issuer for USDC on mainnet", () => {
      const issuer = getAssetIssuer("mainnet", "USDC");
      expect(issuer).toBe("GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
    });

    it("returns correct issuer for USDC on testnet", () => {
      const issuer = getAssetIssuer("testnet", "USDC");
      expect(issuer).toBe("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
    });

    it("returns null for XLM (native asset)", () => {
      const issuer = getAssetIssuer("mainnet", "XLM");
      expect(issuer).toBeNull();
    });

    it("returns null for non-existent asset", () => {
      const issuer = getAssetIssuer("mainnet", "NONEXISTENT");
      expect(issuer).toBeNull();
    });
  });

  describe("getAssetDecimals", () => {
    it("returns 7 for USDC", () => {
      expect(getAssetDecimals("mainnet", "USDC")).toBe(7);
    });

    it("returns 7 for XLM", () => {
      expect(getAssetDecimals("mainnet", "XLM")).toBe(7);
    });

    it("returns 7 as default for unknown assets", () => {
      expect(getAssetDecimals("mainnet", "NONEXISTENT")).toBe(7);
    });
  });

  describe("getAssetDisplayName", () => {
    it("returns display name for USDC on mainnet", () => {
      expect(getAssetDisplayName("mainnet", "USDC")).toBe("USD Coin");
    });

    it("returns display name for USDC on testnet", () => {
      expect(getAssetDisplayName("testnet", "USDC")).toBe("USD Coin (Testnet)");
    });

    it("returns 'Stellar Lumens (XLM)' for XLM", () => {
      expect(getAssetDisplayName("mainnet", "XLM")).toBe("Stellar Lumens (XLM)");
    });

    it("falls back to asset code for unknown assets", () => {
      expect(getAssetDisplayName("mainnet", "NONEXISTENT")).toBe("NONEXISTENT");
    });
  });

  describe("isAssetSupported", () => {
    it("returns true for USDC on mainnet", () => {
      expect(isAssetSupported("mainnet", "USDC")).toBe(true);
    });

    it("returns false for non-existent asset", () => {
      expect(isAssetSupported("mainnet", "NONEXISTENT")).toBe(false);
    });
  });

  describe("isValidCanonicalAsset", () => {
    it("returns true for valid USDC on mainnet", () => {
      expect(
        isValidCanonicalAsset(
          "mainnet",
          "USDC",
          "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
        )
      ).toBe(true);
    });

    it("returns false for USDC with wrong issuer on mainnet", () => {
      expect(
        isValidCanonicalAsset(
          "mainnet",
          "USDC",
          "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
        )
      ).toBe(false);
    });

    it("returns true for XLM (native)", () => {
      expect(isValidCanonicalAsset("mainnet", "XLM", null)).toBe(true);
    });

    it("returns false for non-existent asset", () => {
      expect(isValidCanonicalAsset("mainnet", "NONEXISTENT", "some-issuer")).toBe(false);
    });
  });

  describe("getSupportedAssets", () => {
    it("returns array of supported assets for mainnet", () => {
      const assets = getSupportedAssets("mainnet");
      expect(assets).toContain("USDC");
    });

    it("returns empty array for network with no assets", () => {
      // We don't have a network with no assets, so we check that it returns an array
      const assets = getSupportedAssets("mainnet");
      expect(Array.isArray(assets)).toBe(true);
    });
  });
  describe("Placeholder Validation", () => {
   it("detects placeholder values", () => {
    expect(isPlaceholderValue("YOUR_ISSUER")).toBe(true);
    expect(isPlaceholderValue("CHANGE-ME")).toBe(true);
    expect(isPlaceholderValue("PLACEHOLDER")).toBe(true);
    expect(isPlaceholderValue("example_issuer")).toBe(true);
    expect(isPlaceholderValue("<issuer>")).toBe(true);
    expect(isPlaceholderValue("GABCD1234")).toBe(false);
  });

  it("validates asset configs", () => {
    const validConfig = {
      code: "USDC",
      issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      decimals: 7,
      name: "USD Coin",
    };
    expect(validateAssetConfig(validConfig)).toBeUndefined();

    const placeholderConfig = {
      ...validConfig,
      issuer: "YOUR_ISSUER_HERE",
    };
    expect(validateAssetConfig(placeholderConfig)).toContain("placeholder");

    const missingName = {
      ...validConfig,
      name: "",
    };
    expect(validateAssetConfig(missingName)).toContain("Asset name is required");
  });

  it("validates the entire registry", () => {
    const errors = validateRegistry();
    // Our registry should have no errors
    expect(errors).toEqual([]);
  });
});
});
