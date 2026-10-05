import { describe, expect, it, vi } from "vitest";
import { createRetryQueueClient } from "./retry-queue-client.js";

const WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const OTHER_WALLET = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF";
const CURSOR_ONE = "11111111-1111-4111-8111-111111111111";
const CURSOR_TWO = "22222222-2222-4222-8222-222222222222";

function action(id, overrides = {}) {
  return {
    id,
    wallet_address: WALLET,
    action_type: "deposit",
    action_payload: { vault_id: "v1", amount: "500", token: "USDC" },
    status: "pending",
    error_code: null,
    ...overrides,
  };
}

function response(body, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
}

function page(data, nextCursor = null, limit = 50) {
  return { data, meta: { pagination: {
    has_more: nextCursor !== null,
    next_cursor: nextCursor,
    limit,
  } } };
}

function setup(fetchImpl, getAuthHeaders = async () => ({ "X-Wallet-Address": WALLET })) {
  return createRetryQueueClient({ baseUrl: "http://ledger.test", fetchImpl, getAuthHeaders });
}

describe("retry queue ledger pagination", () => {
  it("finds older queue actions beyond a full confirmed first page", async () => {
    const confirmed = Array.from({ length: 50 }, (_, i) => action(`confirmed-${i}`, {
      status: "confirmed",
    }));
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(page(confirmed, CURSOR_ONE)))
      .mockResolvedValueOnce(response(page([
        action("older-pending"),
        action("older-failed", { status: "failed", error_code: "RPC_TIMEOUT" }),
        action("cancelled", { status: "failed", error_code: "USER_CANCELLED" }),
        action("other-wallet", { wallet_address: OTHER_WALLET }),
      ])));
    const auth = vi.fn()
      .mockResolvedValueOnce({
        "X-Wallet-Address": WALLET,
        "X-Wallet-Signature": "synthetic-page-one",
        "X-Wallet-Timestamp": "1791158400000",
      })
      .mockResolvedValueOnce({
        "X-Wallet-Address": WALLET,
        "X-Wallet-Signature": "synthetic-page-two",
        "X-Wallet-Timestamp": "1791158400001",
      });

    const rows = await setup(fetchImpl, auth).listQueueActions(WALLET);

    expect(rows.map((row) => row.id)).toEqual(["older-pending", "older-failed"]);
    expect(auth).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    fetchImpl.mock.calls.forEach(([url, init], i) => {
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/actions");
      expect(parsed.searchParams.get("wallet")).toBe(WALLET);
      expect(parsed.searchParams.get("limit")).toBe("50");
      expect(parsed.searchParams.has("status")).toBe(false);
      expect(parsed.searchParams.get("cursor")).toBe(i === 0
        ? null : CURSOR_ONE);
      expect(init.method).toBeUndefined();
      expect(init.body).toBeUndefined();
      expect(init.headers).toEqual({
        Accept: "application/json", "X-Wallet-Address": WALLET,
        "X-Wallet-Signature": i === 0 ? "synthetic-page-one" : "synthetic-page-two",
        "X-Wallet-Timestamp": i === 0 ? "1791158400000" : "1791158400001",
      });
    });
  });

  it("preserves an explicit status and limit on every cursor request", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(page([action("first"), action("second")], CURSOR_ONE, 2)))
      .mockResolvedValueOnce(response(page([action("third"), action("fourth")], CURSOR_TWO, 2)))
      .mockResolvedValueOnce(response(page([action("last")], null, 2)));
    expect((await setup(fetchImpl).listQueueActions(WALLET, {
      status: "pending", limit: 2,
    })).map((row) => row.id)).toEqual(["first", "second", "third", "fourth", "last"]);
    expect(fetchImpl.mock.calls.map(([url, init]) => {
      expect(init.headers["X-Wallet-Address"]).toBe(WALLET);
      return Object.fromEntries(new URL(url).searchParams);
    })).toEqual([
      { wallet: WALLET, status: "pending", limit: "2" },
      { wallet: WALLET, status: "pending", limit: "2", cursor: CURSOR_ONE },
      { wallet: WALLET, status: "pending", limit: "2", cursor: CURSOR_TWO },
    ]);
  });

  it.each([
    ["array", [action("legacy")]],
    ["data array", { data: [action("legacy")] }],
    ["items", { data: { items: [action("legacy")] } }],
    ["actions", { actions: [action("legacy")] }],
  ])("retains the legacy single-page %s response", async (_, body) => {
    const fetchImpl = vi.fn().mockResolvedValue(response(body));
    expect((await setup(fetchImpl).listQueueActions(WALLET)).map((row) => row.id))
      .toEqual(["legacy"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["null metadata", null],
    ["missing has_more", { next_cursor: null }],
    ["non-boolean has_more", { has_more: "false", next_cursor: null }],
    ["missing continuation", { has_more: true, next_cursor: null }],
    ["blank continuation", { has_more: true, next_cursor: "  " }],
    ["missing terminal cursor", { has_more: false }],
    ["contradictory terminal cursor", { has_more: false, next_cursor: "extra" }],
  ])("rejects %s instead of returning a partial queue", async (_, pagination) => {
    const fetchImpl = vi.fn().mockResolvedValue(response({
      data: [action("partial")], meta: { pagination },
    }));
    await expect(setup(fetchImpl).listQueueActions(WALLET))
      .rejects.toThrow("Could not load retry queue: invalid pagination.");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing later pagination", { data: [action("later")] }, "invalid pagination"],
    ["invalid later list", page({ unexpected: true }), "invalid ledger page"],
  ])("rejects %s after a valid first page", async (_, body, message) => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(page([action("partial")], CURSOR_ONE, 1)))
      .mockResolvedValueOnce(response(body));
    await expect(setup(fetchImpl).listQueueActions(WALLET, { limit: 1 })).rejects.toThrow(message);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects a repeated server cursor before making a third request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(page([action("partial")], CURSOR_ONE, 1)));
    await expect(setup(fetchImpl).listQueueActions(WALLET, { limit: 1 }))
      .rejects.toThrow("Could not load retry queue: repeated ledger cursor.");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("preserves a later HTTP error without resolving earlier rows", async () => {
    const body = { error: { code: "LEDGER_UNAVAILABLE", message: "Ledger temporarily unavailable" } };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(page([action("partial")], CURSOR_ONE, 1)))
      .mockResolvedValueOnce(response(body, 503));
    await expect(setup(fetchImpl).listQueueActions(WALLET, { limit: 1 })).rejects.toMatchObject({
      message: "Ledger temporarily unavailable", code: "LEDGER_UNAVAILABLE", status: 503, body,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not dispatch a later page when authentication fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(page([action("partial")], CURSOR_ONE, 1)));
    const auth = vi.fn()
      .mockResolvedValueOnce({ "X-Wallet-Address": WALLET })
      .mockRejectedValueOnce(new Error("Wallet authentication expired"));
    await expect(setup(fetchImpl, auth).listQueueActions(WALLET, { limit: 1 }))
      .rejects.toThrow("Wallet authentication expired");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(auth).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("bounds a 100-page history (complete: %s)", async (complete) => {
    let requests = 0;
    const fetchImpl = vi.fn(async () => {
      requests += 1;
      return response(page([action(`page-${requests}`)],
        complete && requests === 100
          ? null : `00000000-0000-4000-8000-${String(requests).padStart(12, "0")}`, 1));
    });
    const result = setup(fetchImpl).listQueueActions(WALLET, { limit: 1 });
    if (complete) expect(await result).toHaveLength(100);
    else await expect(result).rejects.toThrow(
      "Could not load the complete retry queue: page limit reached.",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(100);
  });
});
