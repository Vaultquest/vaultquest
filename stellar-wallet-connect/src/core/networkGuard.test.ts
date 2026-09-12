import { describe, expect, it } from "vitest";
import { evaluateNetworkGate, networkLabel } from "./networkGuard";

// #178: the gate has to distinguish four different situations that used to
// collapse into one "wallet_disconnected" error, and it has to name both
// networks so the advice is actionable.

const KEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function gate(overrides: Partial<Parameters<typeof evaluateNetworkGate>[0]> = {}) {
  return evaluateNetworkGate({
    publicKey: KEY,
    readiness: "verified",
    connectedNetwork: "testnet",
    expectedNetwork: "testnet",
    ...overrides,
  });
}

describe("networkLabel", () => {
  it("names each supported network", () => {
    expect(networkLabel("testnet")).toBe("Testnet");
    expect(networkLabel("mainnet")).toBe("Mainnet");
    expect(networkLabel("futurenet")).toBe("Futurenet");
    expect(networkLabel("standalone")).toBe("Standalone");
  });

  it("does not invent a network it cannot identify", () => {
    expect(networkLabel(null)).toBe("an unknown network");
    expect(networkLabel(undefined)).toBe("an unknown network");
  });
});

describe("evaluateNetworkGate", () => {
  it("allows the action when the wallet is connected and verified", () => {
    const result = gate();
    expect(result.allowed).toBe(true);
    expect(result.code).toBe("ok");
    expect(result.expectedNetwork).toBe("testnet");
    expect(result.actualNetwork).toBe("testnet");
  });

  it("reports a disconnected wallet separately from a network problem", () => {
    const result = gate({ publicKey: "", readiness: "idle", connectedNetwork: null });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("wallet_disconnected");
  });

  it("names both networks on a confirmed mismatch", () => {
    const result = gate({ readiness: "mismatch", connectedNetwork: "mainnet", expectedNetwork: "testnet" });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("network_mismatch");
    expect(result.actualNetwork).toBe("mainnet");
    expect(result.expectedNetwork).toBe("testnet");
    expect(result.message).toContain("Mainnet");
    expect(result.message).toContain("Testnet");
  });

  it("names both networks on a mismatch in the other direction", () => {
    const result = gate({ readiness: "mismatch", connectedNetwork: "testnet", expectedNetwork: "mainnet" });
    expect(result.code).toBe("network_mismatch");
    expect(result.message).toContain("Testnet");
    expect(result.message).toContain("Mainnet");
  });

  it("still says which network is expected when the wallet's network is unknown", () => {
    const result = gate({ readiness: "mismatch", connectedNetwork: null, expectedNetwork: "testnet" });
    expect(result.code).toBe("network_mismatch");
    expect(result.actualNetwork).toBeNull();
    expect(result.message).toContain("Testnet");
    expect(result.message).toMatch(/could not be identified/i);
  });

  it("treats the post-connection verifying window as 'not yet known', not as a failure", () => {
    const result = gate({ readiness: "verifying", connectedNetwork: null });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("network_unverified");
    expect(result.message).toMatch(/still checking/i);
    expect(result.message).toContain("Testnet");
  });

  it("treats idle-with-a-key the same way instead of guessing", () => {
    const result = gate({ readiness: "idle" });
    expect(result.code).toBe("network_unverified");
  });

  it("reports a provider failure as a verification failure, not a mismatch", () => {
    const result = gate({ readiness: "error", connectedNetwork: null });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("network_verification_failed");
    expect(result.message).toMatch(/reconnect/i);
    expect(result.message).toContain("Testnet");
  });

  it("recovers as soon as the wallet reports the expected network", () => {
    const blocked = gate({ readiness: "mismatch", connectedNetwork: "mainnet", expectedNetwork: "testnet" });
    expect(blocked.allowed).toBe(false);

    const recovered = gate({ readiness: "verified", connectedNetwork: "testnet", expectedNetwork: "testnet" });
    expect(recovered.allowed).toBe(true);
    expect(recovered.code).toBe("ok");
  });

  it("never allows an action while the network is unverified", () => {
    for (const readiness of ["idle", "verifying", "mismatch", "error"] as const) {
      expect(gate({ readiness }).allowed).toBe(false);
    }
  });
});
