import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// walletService reads `kit` from ./kit.js as a live singleton; mock it so we
// control what getNetwork() resolves/rejects with and on what schedule.
vi.mock("./kit.js", () => ({
  kit: {
    getNetwork: vi.fn(),
    setWallet: vi.fn(),
    getAddress: vi.fn(),
    disconnect: vi.fn(),
    getSupportedWallets: vi.fn(async () => []),
  },
}));

import { kit } from "./kit.js";
import { networkReadiness, isNetworkMismatch, connectedNetwork } from "./store.js";
import { setConnection, disconnect } from "./walletService.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("walletService network verification gating (issue #101)", () => {
  beforeEach(() => {
    localStorage.clear();
    networkReadiness.set("idle");
    isNetworkMismatch.set(false);
    connectedNetwork.set(null);
    vi.mocked(kit.getNetwork).mockReset();
  });

  afterEach(() => {
    disconnect();
  });

  it("is 'verifying' (not 'verified') immediately after connecting, before the network check resolves", () => {
    const pending = deferred<{ network: string }>();
    vi.mocked(kit.getNetwork).mockReturnValue(pending.promise as any);

    setConnection("GALICE00000000000000000000000000000000000000000000000", "freighter");

    // No contract action may be treated as ready at this point.
    expect(networkReadiness.get()).toBe("verifying");
    expect(networkReadiness.get()).not.toBe("verified");
  });

  it("moves to 'verified' once the network check resolves to the expected network", async () => {
    vi.mocked(kit.getNetwork).mockResolvedValue({ network: "testnet" } as any);

    setConnection("GALICE00000000000000000000000000000000000000000000000", "freighter");
    // allow the microtask queue to flush
    await Promise.resolve();
    await Promise.resolve();

    expect(networkReadiness.get()).toBe("verified");
    expect(isNetworkMismatch.get()).toBe(false);
  });

  it("moves to 'mismatch' (never 'verified') when the connected network differs", async () => {
    vi.mocked(kit.getNetwork).mockResolvedValue({ network: "mainnet" } as any);

    setConnection("GALICE00000000000000000000000000000000000000000000000", "freighter");
    await Promise.resolve();
    await Promise.resolve();

    expect(networkReadiness.get()).toBe("mismatch");
    expect(networkReadiness.get()).not.toBe("verified");
    expect(isNetworkMismatch.get()).toBe(true);
  });

  it("moves to 'error' (never 'verified') when network verification throws", async () => {
    vi.mocked(kit.getNetwork).mockRejectedValue(new Error("wallet unavailable"));

    setConnection("GALICE00000000000000000000000000000000000000000000000", "freighter");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(networkReadiness.get()).toBe("error");
    expect(networkReadiness.get()).not.toBe("verified");
  });

  it("ignores a stale verification result after a network switch mid-flight", async () => {
    const first = deferred<{ network: string }>();
    vi.mocked(kit.getNetwork).mockReturnValueOnce(first.promise as any);

    setConnection("GALICE00000000000000000000000000000000000000000000000", "freighter");
    expect(networkReadiness.get()).toBe("verifying");

    // A second connect (e.g. account/network switch) starts before the
    // first verification resolves.
    vi.mocked(kit.getNetwork).mockResolvedValueOnce({ network: "testnet" } as any);
    setConnection("GBOB000000000000000000000000000000000000000000000000", "freighter");
    await Promise.resolve();
    await Promise.resolve();
    expect(networkReadiness.get()).toBe("verified");

    // The stale first verification now resolves with a mismatched network;
    // it must be ignored rather than clobbering the fresher "verified" state.
    first.resolve({ network: "mainnet" });
    await Promise.resolve();
    await Promise.resolve();

    expect(networkReadiness.get()).toBe("verified");
  });

  it("resets to 'idle' on disconnect and ignores any in-flight verification afterward", async () => {
    const pending = deferred<{ network: string }>();
    vi.mocked(kit.getNetwork).mockReturnValue(pending.promise as any);

    setConnection("GALICE00000000000000000000000000000000000000000000000", "freighter");
    expect(networkReadiness.get()).toBe("verifying");

    disconnect();
    expect(networkReadiness.get()).toBe("idle");

    pending.resolve({ network: "testnet" });
    await Promise.resolve();
    await Promise.resolve();

    // Must still be idle - a disconnected wallet can never become "verified".
    expect(networkReadiness.get()).toBe("idle");
  });
});
