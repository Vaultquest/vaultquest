import React from "react";
import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import VaultRetryQueue from "./VaultRetryQueue";
import { createRetryQueueClient } from "@/lib/retry-queue-client";

const WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const WALLET_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF";
const CURSOR = "11111111-1111-4111-8111-111111111111";

function action(id, wallet = WALLET, status = "pending") {
  return {
    id, wallet_address: wallet, action_type: "deposit", status,
    error_code: status === "failed" ? "RPC_TIMEOUT" : null,
    created_at: "2026-10-05T00:00:00.000Z",
    action_payload: { vault_id: "v1", pool_name: id, amount: "500", token: "USDC" },
  };
}

function page(data, nextCursor = null) {
  return { ok: true, text: async () => JSON.stringify({ data, meta: { pagination: {
    has_more: nextCursor !== null, next_cursor: nextCursor, limit: 50,
  } } }) };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function clientFor(fetchImpl, getAuthHeaders = async () => ({ "X-Wallet-Address": WALLET })) {
  return createRetryQueueClient({ baseUrl: "http://ledger.test", fetchImpl, getAuthHeaders });
}

describe("VaultRetryQueue with the real paginated client", () => {
  it("renders older pending and failed actions beyond 50 confirmed records", async () => {
    const tail = deferred();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(page(Array.from({ length: 50 }, (_, i) =>
        action(`confirmed-${i}`, WALLET, "confirmed")), CURSOR))
      .mockReturnValueOnce(tail.promise);
    const requestSign = vi.fn();
    render(<VaultRetryQueue walletAddress={WALLET} client={clientFor(fetchImpl)} requestSign={requestSign} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/Loading actions from the ledger/)).toBeInTheDocument();
    expect(document.querySelector("[data-action-id]")).toBeNull();
    await act(async () => tail.resolve(page([
      action("older-pending"), action("older-failed", WALLET, "failed"),
    ])));
    expect(screen.getByText(/older-pending/)).toBeInTheDocument();
    expect(screen.getByText(/older-failed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel pending action" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry deposit" })).toBeInTheDocument();
    expect(fetchImpl.mock.calls.every(([, init]) => !init.method && !init.body)).toBe(true);
    expect(requestSign).not.toHaveBeenCalled();
  });

  it("shows a later page's stable error and never renders partial actions", async () => {
    const tail = deferred();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(page([
        action("partial-action"), ...Array.from({ length: 49 }, (_, i) =>
          action(`confirmed-${i}`, WALLET, "confirmed")),
      ], CURSOR))
      .mockReturnValueOnce(tail.promise);
    render(<VaultRetryQueue walletAddress={WALLET} client={clientFor(fetchImpl)} />);
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(document.querySelector("[data-action-id]")).toBeNull();
    await act(async () => tail.resolve({
      ok: false, status: 503,
      text: async () => JSON.stringify({ error: {
        code: "LEDGER_UNAVAILABLE", message: "Ledger temporarily unavailable",
      } }),
    }));
    expect(screen.getByRole("alert")).toHaveTextContent("Ledger temporarily unavailable");
    expect(document.querySelector("[data-action-id]")).toBeNull();
    expect(screen.queryByText(/Loading actions from the ledger/)).toBeNull();
  });

  it.each(["success", "failure"])(
    "ignores wallet A's late paginated %s after wallet B loads",
    async (outcome) => {
      const tail = deferred();
      let activeWallet = WALLET;
      const fetchImpl = vi.fn(async (url, init) => {
        const params = new URL(url).searchParams;
        const wallet = params.get("wallet");
        expect(init.headers["X-Wallet-Address"]).toBe(wallet);
        expect(init.method).toBeUndefined();
        if (wallet === WALLET_B) return page([action("current-wallet-pool", WALLET_B)]);
        if (params.has("cursor")) return tail.promise;
        return page([
          action("old-first-page"), ...Array.from({ length: 49 }, (_, i) =>
            action(`confirmed-${i}`, WALLET, "confirmed")),
        ], CURSOR);
      });
      const client = clientFor(fetchImpl, async () => ({ "X-Wallet-Address": activeWallet }));
      const { rerender } = render(<VaultRetryQueue walletAddress={WALLET} client={client} />);
      await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
      activeWallet = WALLET_B;
      rerender(<VaultRetryQueue walletAddress={WALLET_B} client={client} />);
      try {
        await screen.findByText(/current-wallet-pool/);
      } finally {
        await act(async () => tail.resolve(outcome === "success"
          ? page([action("old-tail-page")])
          : { ok: false, status: 500, text: async () => JSON.stringify({ message: "Old wallet error" }) }));
      }
      expect(screen.getByText(/current-wallet-pool/)).toBeInTheDocument();
      expect(screen.queryByText(/old-first-page/)).toBeNull();
      expect(screen.queryByText(/old-tail-page/)).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    },
  );
});
