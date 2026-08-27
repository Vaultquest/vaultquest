import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RPC,
  pingEvmRpc,
  pingHorizon,
  readStoredRpc,
  RPC_STORAGE_KEY,
  validateRpcEndpoint,
  writeStoredRpc,
} from "@/lib/customRpc";

describe("validateRpcEndpoint", () => {
  it("accepts valid HTTPS nodes", () => {
    expect(validateRpcEndpoint("https://horizon-testnet.stellar.org").ok).toBe(true);
    expect(validateRpcEndpoint("https://api.avax.network/ext/bc/C/rpc").ok).toBe(true);
  });

  it("accepts explicit localhost over HTTP for development", () => {
    expect(validateRpcEndpoint("http://localhost:8000").ok).toBe(true);
    expect(validateRpcEndpoint("http://127.0.0.1:8000").ok).toBe(true);
    expect(validateRpcEndpoint("http://[::1]:8000").ok).toBe(true);
  });

  it("rejects plain HTTP for non-localhost hosts", () => {
    const result = validateRpcEndpoint("http://example.com/rpc");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/https/i);
  });

  it("rejects URLs with embedded credentials (userinfo)", () => {
    const result = validateRpcEndpoint("https://user:pass@example.com/rpc");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/credentials/i);
  });

  it("rejects malformed URLs", () => {
    expect(validateRpcEndpoint("not a url").ok).toBe(false);
    expect(validateRpcEndpoint("").ok).toBe(false);
  });

  it("rejects private and reserved IPv4 network addresses", () => {
    expect(validateRpcEndpoint("https://10.0.0.5/rpc").ok).toBe(false);
    expect(validateRpcEndpoint("https://172.16.5.1/rpc").ok).toBe(false);
    expect(validateRpcEndpoint("https://192.168.1.1/rpc").ok).toBe(false);
    expect(validateRpcEndpoint("https://169.254.169.254/latest/meta-data").ok).toBe(false);
    expect(validateRpcEndpoint("https://0.0.0.0/rpc").ok).toBe(false);
  });

  it("rejects private and reserved IPv6 network addresses", () => {
    expect(validateRpcEndpoint("https://[fc00::1]/rpc").ok).toBe(false);
    expect(validateRpcEndpoint("https://[fe80::1]/rpc").ok).toBe(false);
  });
});

describe("pingHorizon", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("rejects unsafe endpoints before making a network request", async () => {
    global.fetch = vi.fn();
    const result = await pingHorizon("http://192.168.1.1/");
    expect(result.ok).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects a manual redirect response", async () => {
    global.fetch = vi.fn().mockResolvedValue({ type: "opaqueredirect", status: 0, ok: false });
    const result = await pingHorizon("https://horizon.example.com");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/redirect/i);
  });

  it("rejects malformed JSON responses", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      type: "basic",
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError("Unexpected token")),
    });
    const result = await pingHorizon("https://horizon.example.com");
    expect(result.ok).toBe(false);
  });

  it("rejects a Horizon node reporting the wrong network passphrase", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      type: "basic",
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ horizon_version: "1.0", network_passphrase: "Public Global Stellar Network ; September 2015" }),
    });
    const result = await pingHorizon("https://horizon.example.com");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/network/i);
  });

  it("accepts a valid Horizon node on the expected network", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      type: "basic",
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ horizon_version: "1.0", network_passphrase: "Test SDF Network ; September 2015" }),
    });
    const result = await pingHorizon(DEFAULT_RPC.horizon);
    expect(result.ok).toBe(true);
  });
});

describe("pingEvmRpc", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("rejects a node reporting the wrong chain ID", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      type: "basic",
      ok: true,
      status: 200,
      json: () => Promise.resolve({ jsonrpc: "2.0", id: 1, result: "0xa869" }), // Fuji, not mainnet
    });
    const result = await pingEvmRpc("https://rpc.example.com", 43114);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/chain/i);
  });

  it("accepts a node reporting the expected chain ID", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      type: "basic",
      ok: true,
      status: 200,
      json: () => Promise.resolve({ jsonrpc: "2.0", id: 1, result: "0xa86a" }), // 43114
    });
    const result = await pingEvmRpc("https://rpc.example.com", 43114);
    expect(result.ok).toBe(true);
  });

  it("mitigates DNS rebinding by re-checking chain identity on every call, rejecting a node that answers on the wrong chain after having passed a prior check", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        type: "basic",
        ok: true,
        status: 200,
        json: () => Promise.resolve({ jsonrpc: "2.0", id: 1, result: "0xa86a" }), // 43114, matches on first call
      })
      .mockResolvedValueOnce({
        type: "basic",
        ok: true,
        status: 200,
        json: () => Promise.resolve({ jsonrpc: "2.0", id: 1, result: "0x1" }), // hostname now resolves elsewhere
      });

    const first = await pingEvmRpc("https://rebinder.example.com", 43114);
    expect(first.ok).toBe(true);

    const second = await pingEvmRpc("https://rebinder.example.com", 43114);
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/chain/i);
  });
});

describe("readStoredRpc / writeStoredRpc", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("writeStoredRpc rejects unsafe candidates and keeps prior safe values", () => {
    const next = writeStoredRpc({ horizon: "http://169.254.169.254/", avalanche: "https://good.example.com/rpc" });
    expect(next.horizon).toBe(DEFAULT_RPC.horizon);
    expect(next.avalanche).toBe("https://good.example.com/rpc");
  });

  it("readStoredRpc self-heals a tampered, unsafe stored entry", () => {
    localStorage.setItem(
      RPC_STORAGE_KEY,
      JSON.stringify({ horizon: "http://10.0.0.1/", avalanche: DEFAULT_RPC.avalanche, avalancheFuji: DEFAULT_RPC.avalancheFuji }),
    );
    const stored = readStoredRpc();
    expect(stored.horizon).toBe(DEFAULT_RPC.horizon);
    const persisted = JSON.parse(localStorage.getItem(RPC_STORAGE_KEY));
    expect(persisted.horizon).toBe(DEFAULT_RPC.horizon);
  });

  it("readStoredRpc keeps a valid stored entry as-is", () => {
    localStorage.setItem(
      RPC_STORAGE_KEY,
      JSON.stringify({ horizon: "https://custom-horizon.example.com", avalanche: DEFAULT_RPC.avalanche, avalancheFuji: DEFAULT_RPC.avalancheFuji }),
    );
    const stored = readStoredRpc();
    expect(stored.horizon).toBe("https://custom-horizon.example.com");
  });
});
