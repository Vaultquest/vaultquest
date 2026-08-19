import { describe, it, expect, vi, afterEach } from "vitest";

// setConnection kicks off a background network check via `kit`; mock it so
// it never throws unhandled in these tests.
vi.mock("./kit.js", () => ({
  kit: {
    getNetwork: vi.fn(async () => ({ network: "testnet" })),
    setWallet: vi.fn(),
    getAddress: vi.fn(),
    disconnect: vi.fn(),
    getSupportedWallets: vi.fn(async () => []),
  },
}));

import { HorizonPool } from "./horizonPool.js";
import { setConnection, disconnect, getWalletHealth, setHorizonPool } from "./walletService.js";

const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
let keyCounter = 0;
function freshKey(): string {
  keyCounter += 1;
  return `GBAL${String(keyCounter).padStart(3, "0")}0000000000000000000000000000000000000000000`.slice(0, 56);
}

function res(status: number, body: unknown = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

function stubPool(request: (path: string, init?: RequestInit) => Promise<Response>): HorizonPool {
  return { request } as unknown as HorizonPool;
}

describe("getWalletHealth balance precision (issue #106)", () => {
  afterEach(() => {
    setHorizonPool(undefined);
    disconnect();
  });

  it("keeps a maximum-safe-boundary XLM balance exact, with asset identity attached", async () => {
    setConnection(freshKey(), "freighter");
    setHorizonPool(stubPool(async () => res(200, {
      balances: [{ asset_type: "native", balance: "9007199254740992.1234567" }],
    })));

    const health = await getWalletHealth();
    expect(health.exists).toBe(true);
    expect(health.balances.XLM).toEqual({
      assetCode: "XLM",
      assetIssuer: "native",
      decimals: 7,
      decimal: "9007199254740992.1234567",
      minorUnits: "90071992547409921234567",
    });
  });

  it("keeps a full 7-decimal USDC balance exact and attaches its issuer/decimals", async () => {
    setConnection(freshKey(), "freighter");
    setHorizonPool(stubPool(async () => res(200, {
      balances: [
        { asset_type: "native", balance: "5.0000000" },
        { asset_code: "USDC", issuer: USDC_ISSUER, balance: "0.1234567" },
      ],
    })));

    const health = await getWalletHealth();
    expect(health.balances.USDC).toEqual({
      assetCode: "USDC",
      assetIssuer: USDC_ISSUER,
      decimals: 7,
      decimal: "0.1234567",
      minorUnits: "1234567",
    });
  });

  it("never renders balances in scientific notation", async () => {
    setConnection(freshKey(), "freighter");
    setHorizonPool(stubPool(async () => res(200, {
      balances: [{ asset_type: "native", balance: "0.0000001" }],
    })));

    const health = await getWalletHealth();
    expect(health.balances.XLM.decimal).toBe("0.0000001");
    expect(health.balances.XLM.decimal).not.toMatch(/e/i);
  });

  it("returns zero AssetAmounts (with asset identity) when there is no balance line, not bare zero", async () => {
    setConnection(freshKey(), "freighter");
    setHorizonPool(stubPool(async () => res(200, { balances: [] })));

    const health = await getWalletHealth();
    expect(health.balances.XLM).toEqual({
      assetCode: "XLM",
      assetIssuer: "native",
      decimals: 7,
      decimal: "0",
      minorUnits: "0",
    });
  });
});
