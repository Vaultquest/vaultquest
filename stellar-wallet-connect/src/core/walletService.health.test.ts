import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// setConnection kicks off a background network check via `kit`; mock it so
// that never throws unhandled in these tests (network verification itself
// is covered by walletService.test.ts / issue #101).
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

let keyCounter = 0;
/** A fresh Stellar-shaped public key per test, so the last-known-good cache
 * (keyed by public key) never leaks state between unrelated tests. */
function freshKey(): string {
  keyCounter += 1;
  return `GHEALTH${String(keyCounter).padStart(3, "0")}0000000000000000000000000000000000000000`.slice(0, 56);
}

function res(status: number, body: unknown = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

/** Routes through the real HorizonPool so its own 429/5xx retry-then-throw
 * behavior is exercised (no retry delay: maxRetries 1, sleep is a no-op). */
function realPoolReturning(fetchImpl: (...args: any[]) => Promise<Response>): HorizonPool {
  return new HorizonPool({
    nodes: [{ url: "https://horizon.example", kind: "public" }],
    fetchImpl: fetchImpl as any,
    maxRetries: 1,
    sleep: async () => {},
  });
}

/** A minimal pool stub that returns whatever Response is given verbatim,
 * bypassing HorizonPool's own retry/backoff so getWalletHealth's own
 * per-status branches (404 / 429 / other non-OK) can be exercised directly. */
function stubPool(request: (path: string, init?: RequestInit) => Promise<Response>): HorizonPool {
  return { request } as unknown as HorizonPool;
}

const NATIVE_BALANCE = {
  balances: [
    { asset_type: "native", balance: "42.5000000" },
    {
      asset_code: "USDC",
      issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      balance: "10.0000000",
    },
  ],
};

describe("getWalletHealth status discrimination (issue #103)", () => {
  afterEach(() => {
    setHorizonPool(undefined);
    disconnect();
  });

  it("returns 'not-found' only for an authoritative 404", async () => {
    setConnection(freshKey(), "freighter");
    setHorizonPool(stubPool(async () => res(404)));
    const health = await getWalletHealth();
    expect(health.status).toBe("not-found");
    expect(health.exists).toBe(false);
    expect(health.balances).toBeNull();
  });

  it("returns 'ready' with balances for a 200 response", async () => {
    setConnection(freshKey(), "freighter");
    setHorizonPool(stubPool(async () => res(200, NATIVE_BALANCE)));
    const health = await getWalletHealth();
    expect(health.status).toBe("ready");
    expect(health.exists).toBe(true);
    expect(health.balances).toEqual({ XLM: 42.5, USDC: 10 });
    expect(health.asOfMs).not.toBeNull();
  });

  it("returns 'unavailable' (never zero balances) for a persistent 500, via the real retrying pool", async () => {
    setConnection(freshKey(), "freighter");
    // HorizonPool itself retries 5xx/429 internally and throws once
    // exhausted rather than returning the raw response - exercise that
    // real path so the outage genuinely never looks like "not-found".
    setHorizonPool(realPoolReturning(async () => res(500)));
    const health = await getWalletHealth();
    expect(health.status).toBe("unavailable");
    expect(health.exists).toBe(false);
    expect(health.balances).toBeNull();
  });

  it("classifies an explicit 429 as 'rate-limited', never zero balances", async () => {
    // getWalletHealth's own branch, exercised directly (the real pool
    // already retries 429s itself before ever surfacing one - see above).
    setConnection(freshKey(), "freighter");
    setHorizonPool(stubPool(async () => res(429)));
    const health = await getWalletHealth();
    expect(health.status).toBe("rate-limited");
    expect(health.exists).toBe(false);
    expect(health.balances).toBeNull();
  });

  it("returns 'unavailable' (never zero balances) when the request throws (timeout/DNS/etc.)", async () => {
    setConnection(freshKey(), "freighter");
    setHorizonPool(realPoolReturning(async () => {
      throw new Error("network timeout");
    }));
    const health = await getWalletHealth();
    expect(health.status).toBe("unavailable");
    expect(health.exists).toBe(false);
    expect(health.balances).toBeNull();
  });

  it("returns 'invalid-response' for malformed JSON, never zero balances", async () => {
    setConnection(freshKey(), "freighter");
    setHorizonPool(stubPool(async () => res(200, "not json{{{")));
    const health = await getWalletHealth();
    expect(health.status).toBe("invalid-response");
    expect(health.exists).toBe(false);
    expect(health.balances).toBeNull();
  });

  it("serves stale last-known-good data on a subsequent outage, tagged as stale", async () => {
    const key = freshKey();
    setConnection(key, "freighter");
    setHorizonPool(stubPool(async () => res(200, NATIVE_BALANCE)));
    const fresh = await getWalletHealth();
    expect(fresh.status).toBe("ready");
    expect(fresh.stale).toBe(false);

    setHorizonPool(realPoolReturning(async () => res(503)));
    const duringOutage = await getWalletHealth();
    expect(duringOutage.status).toBe("unavailable");
    expect(duringOutage.stale).toBe(true);
    expect(duringOutage.exists).toBe(true);
    expect(duringOutage.balances).toEqual({ XLM: 42.5, USDC: 10 });
    expect(duringOutage.asOfMs).toBe(fresh.asOfMs);
  });

  it("recovers to a fresh 'ready' result once Horizon is healthy again", async () => {
    setConnection(freshKey(), "freighter");
    setHorizonPool(stubPool(async () => res(200, NATIVE_BALANCE)));
    await getWalletHealth();

    setHorizonPool(realPoolReturning(async () => res(503)));
    await getWalletHealth();

    setHorizonPool(stubPool(async () => res(200, NATIVE_BALANCE)));
    const recovered = await getWalletHealth();
    expect(recovered.status).toBe("ready");
    expect(recovered.stale).toBe(false);
  });
});
