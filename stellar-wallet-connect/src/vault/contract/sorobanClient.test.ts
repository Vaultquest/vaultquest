import { describe, it, expect, vi, beforeEach } from "vitest";
import { rpc } from "@stellar/stellar-sdk";
import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { createSorobanVaultClient } from "./sorobanClient";
import { connectedPublicKey, connectedNetwork, networkReadiness } from "../../core/store";

const ADDRESS = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

vi.mock("@stellar/stellar-sdk", () => {
  class FakeTx {
    toXDR() {
      return "fake-unsigned-xdr";
    }
  }
  class FakeTransactionBuilder {
    addOperation() {
      return this;
    }
    setTimeout() {
      return this;
    }
    build() {
      return new FakeTx();
    }
    static fromXDR() {
      return new FakeTx();
    }
  }
  return {
    Account: vi.fn(),
    Address: { fromString: vi.fn(() => ({ toScVal: () => ({}) })) },
    BASE_FEE: "100",
    // Constructible on purpose: the client builds contracts with new, and an
    // arrow implementation cannot be constructed - which is why every test in
    // this file failed with a "not a constructor" error before this change.
    Contract: vi.fn(function () {
      return { call: vi.fn(() => ({})) };
    }),
    TransactionBuilder: FakeTransactionBuilder,
    nativeToScVal: vi.fn(() => ({})),
    scValToNative: vi.fn(() => "0"),
    rpc: {
      Server: vi.fn(),
      Api: {
        GetTransactionStatus: { NOT_FOUND: "NOT_FOUND", SUCCESS: "SUCCESS", FAILED: "FAILED" },
        isSimulationError: vi.fn(() => false),
      },
    },
  };
});

vi.mock("@creit.tech/stellar-wallets-kit", () => ({
  StellarWalletsKit: { signTransaction: vi.fn() },
}));

function makeClient(overrides: Partial<{ pollIntervalMs: number; pollTimeoutMs: number }> = {}) {
  return createSorobanVaultClient({
    contractId: "CDRIPPOOL",
    rpcUrl: "https://rpc.testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    network: "testnet",
    pollIntervalMs: 1,
    pollTimeoutMs: 20,
    ...overrides,
  });
}

/** Default happy-path server stub; tests override individual methods. */
function baseServerStub() {
  return {
    getAccount: vi.fn().mockResolvedValue({ accountId: () => ADDRESS }),
    prepareTransaction: vi.fn().mockImplementation(async (tx: unknown) => tx),
    simulateTransaction: vi.fn(),
    sendTransaction: vi.fn().mockResolvedValue({ status: "PENDING", hash: "txhash123" }),
    getTransaction: vi.fn().mockResolvedValue({ status: "SUCCESS" }),
  };
}

describe("SorobanVaultClient — submitAction", () => {
  beforeEach(() => {
    connectedPublicKey.set(ADDRESS);
    networkReadiness.set("verified");
    vi.mocked(StellarWalletsKit.signTransaction).mockReset().mockResolvedValue({
      signedTxXdr: "fake-signed-xdr",
      signerAddress: ADDRESS,
    } as never);
  });

  it("builds, signs, submits, and confirms a real deposit", async () => {
    const server = baseServerStub();
    vi.mocked(rpc.Server).mockImplementation(function () { return server; } as never);
    const client = makeClient();

    const result = await client.submitAction("join", {
      poolId: "pool-1",
      walletAddress: ADDRESS,
      amount: "10",
    });

    expect(result).toEqual({ txHash: "txhash123", status: "submitted" });
    expect(StellarWalletsKit.signTransaction).toHaveBeenCalledWith(
      "fake-unsigned-xdr",
      expect.objectContaining({ address: ADDRESS }),
    );
    expect(server.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("blocks the action before building a transaction when no wallet is connected", async () => {
    connectedPublicKey.set("");
    const server = baseServerStub();
    vi.mocked(rpc.Server).mockImplementation(function () { return server; } as never);
    const client = makeClient();

    await expect(
      client.submitAction("join", { poolId: "pool-1", walletAddress: ADDRESS, amount: "10" }),
    ).rejects.toMatchObject({ kind: "wallet_disconnected" });
    expect(server.getAccount).not.toHaveBeenCalled();
  });

  it("blocks the action on a wrong network, names both networks, and never builds a transaction", async () => {
    connectedNetwork.set("mainnet");
    networkReadiness.set("mismatch");
    const server = baseServerStub();
    vi.mocked(rpc.Server).mockImplementation(function () { return server; } as never);
    const client = makeClient();

    await expect(
      client.submitAction("join", { poolId: "pool-1", walletAddress: ADDRESS, amount: "10" }),
    ).rejects.toMatchObject({ kind: "network_mismatch" });
    expect(server.getAccount).not.toHaveBeenCalled();
    expect(server.prepareTransaction).not.toHaveBeenCalled();
    expect(StellarWalletsKit.signTransaction).not.toHaveBeenCalled();
  });

  it("reports the mismatch message with the expected and actual network", async () => {
    connectedNetwork.set("mainnet");
    networkReadiness.set("mismatch");
    const server = baseServerStub();
    vi.mocked(rpc.Server).mockImplementation(function () { return server; } as never);
    const client = makeClient();

    await expect(
      client.submitAction("withdraw", { poolId: "pool-1", walletAddress: ADDRESS, amount: "5" }),
    ).rejects.toThrow(/Mainnet[\s\S]*Testnet|Testnet[\s\S]*Mainnet/);
  });

  it("blocks while the network is still being verified, and allows the action once it is verified", async () => {
    networkReadiness.set("verifying");
    const server = baseServerStub();
    vi.mocked(rpc.Server).mockImplementation(function () { return server; } as never);
    const client = makeClient();

    await expect(
      client.submitAction("join", { poolId: "pool-1", walletAddress: ADDRESS, amount: "10" }),
    ).rejects.toMatchObject({ kind: "network_unverified" });
    expect(server.getAccount).not.toHaveBeenCalled();

    // Recovery: the user switches (or the check finishes) and the same call
    // proceeds without reconnecting.
    connectedNetwork.set("testnet");
    networkReadiness.set("verified");
    await expect(
      client.submitAction("join", { poolId: "pool-1", walletAddress: ADDRESS, amount: "10" }),
    ).resolves.toBeTruthy();
    expect(server.getAccount).toHaveBeenCalled();
  });

  it("surfaces a rejected wallet signature and never marks the deposit successful", async () => {
    const server = baseServerStub();
    vi.mocked(rpc.Server).mockImplementation(function () { return server; } as never);
    vi.mocked(StellarWalletsKit.signTransaction).mockRejectedValue(new Error("User declined access"));
    const client = makeClient();

    await expect(
      client.submitAction("join", { poolId: "pool-1", walletAddress: ADDRESS, amount: "10" }),
    ).rejects.toMatchObject({ kind: "signature_rejected" });
    expect(server.sendTransaction).not.toHaveBeenCalled();
  });

  it("surfaces a simulation failure without ever requesting a signature", async () => {
    const server = baseServerStub();
    server.getAccount.mockRejectedValue(new Error("simulation: contract trapped"));
    vi.mocked(rpc.Server).mockImplementation(function () { return server; } as never);
    const client = makeClient();

    await expect(
      client.submitAction("join", { poolId: "pool-1", walletAddress: ADDRESS, amount: "10" }),
    ).rejects.toMatchObject({ kind: "contract_error" });
    expect(StellarWalletsKit.signTransaction).not.toHaveBeenCalled();
  });

  it("surfaces an RPC failure on submission", async () => {
    const server = baseServerStub();
    server.sendTransaction.mockRejectedValue(new Error("network unreachable"));
    vi.mocked(rpc.Server).mockImplementation(function () { return server; } as never);
    const client = makeClient();

    await expect(
      client.submitAction("join", { poolId: "pool-1", walletAddress: ADDRESS, amount: "10" }),
    ).rejects.toMatchObject({ kind: "rpc_failure" });
  });

  it("times out (rpc_failure) if the transaction never leaves NOT_FOUND within the poll budget", async () => {
    const server = baseServerStub();
    server.getTransaction.mockResolvedValue({ status: "NOT_FOUND" });
    vi.mocked(rpc.Server).mockImplementation(function () { return server; } as never);
    const client = makeClient({ pollIntervalMs: 1, pollTimeoutMs: 5 });

    await expect(
      client.submitAction("join", { poolId: "pool-1", walletAddress: ADDRESS, amount: "10" }),
    ).rejects.toMatchObject({ kind: "rpc_failure" });
  });

  it("polls past NOT_FOUND to a late SUCCESS instead of guessing after a fixed delay", async () => {
    const server = baseServerStub();
    server.getTransaction
      .mockResolvedValueOnce({ status: "NOT_FOUND" })
      .mockResolvedValueOnce({ status: "NOT_FOUND" })
      .mockResolvedValueOnce({ status: "SUCCESS" });
    vi.mocked(rpc.Server).mockImplementation(function () { return server; } as never);
    const client = makeClient();

    const result = await client.submitAction("join", {
      poolId: "pool-1",
      walletAddress: ADDRESS,
      amount: "10",
    });

    expect(result.status).toBe("submitted");
    expect(server.getTransaction).toHaveBeenCalledTimes(3);
  });

  it("rejects when the network reports the transaction FAILED, rather than reporting success", async () => {
    const server = baseServerStub();
    server.getTransaction.mockResolvedValue({ status: "FAILED" });
    vi.mocked(rpc.Server).mockImplementation(function () { return server; } as never);
    const client = makeClient();

    await expect(
      client.submitAction("join", { poolId: "pool-1", walletAddress: ADDRESS, amount: "10" }),
    ).rejects.toMatchObject({ kind: "contract_error" });
  });

  it("rejects unsupported action types instead of fabricating a result", async () => {
    const server = baseServerStub();
    vi.mocked(rpc.Server).mockImplementation(function () { return server; } as never);
    const client = makeClient();

    await expect(
      client.submitAction("claim", { poolId: "pool-1", walletAddress: ADDRESS }),
    ).rejects.toMatchObject({ kind: "contract_error" });
    expect(server.getAccount).not.toHaveBeenCalled();
  });
});

// Duplicate-submission protection lives in `useTxFlow`'s `inFlightRef` guard
// (see `../lib/txStateMachine.test.ts`, "ignores a second run() while one is
// already in flight") — every caller of this client goes through that hook,
// so it isn't re-implemented at the client layer here.
