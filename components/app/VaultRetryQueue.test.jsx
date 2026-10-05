import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import VaultRetryQueue from "./VaultRetryQueue";
import { connectedPublicKey } from "@vaultquest/stellar-wallet-connect/src/core/store";
import { createRetryQueueClient } from "@/lib/retry-queue-client";

const WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const WALLET_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF";

function makeRow(overrides = {}) {
  return {
    id: "act-001",
    type: "deposit",
    pool: "USDC Yield Pool",
    amount: "500",
    token: "USDC",
    status: "failed",
    errorCode: "WALLET_REJECTED",
    errorDetail: "User rejected",
    createdAt: new Date().toISOString(),
    retryCount: 0,
    walletAddress: WALLET,
    parentActionId: null,
    payload: { vault_id: "v1", amount: "500", token: "USDC" },
    ledger: { id: "act-001", status: "failed" },
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("VaultRetryQueue", () => {
  beforeEach(() => {
    connectedPublicKey.set("");
  });

  it("renders nothing without a connected wallet", () => {
    const client = {
      listQueueActions: vi.fn(),
    };
    const { container } = render(<VaultRetryQueue client={client} />);
    expect(container).toBeEmptyDOMElement();
    expect(client.listQueueActions).not.toHaveBeenCalled();
  });

  it("loads ledger-backed rows for the connected wallet", async () => {
    connectedPublicKey.set(WALLET);
    const client = {
      listQueueActions: vi.fn().mockResolvedValue([makeRow()]),
    };
    render(<VaultRetryQueue client={client} />);
    await waitFor(() => {
      expect(screen.getByText(/USDC Yield Pool/)).toBeInTheDocument();
    });
    expect(client.listQueueActions).toHaveBeenCalledWith(WALLET);
    expect(screen.getByRole("button", { name: /Retry deposit/i })).toBeInTheDocument();
  });

  it("creates a fresh linked attempt on retry without auto-signing", async () => {
    connectedPublicKey.set(WALLET);
    const created = makeRow({
      id: "act-retry",
      status: "pending",
      errorCode: null,
      parentActionId: "act-001",
    });
    const client = {
      listQueueActions: vi.fn().mockResolvedValue([makeRow()]),
      getAction: vi.fn().mockResolvedValue(makeRow()),
      createRetryAttempt: vi.fn().mockResolvedValue({
        action: created,
        signature: null,
        parentActionId: "act-001",
      }),
      cancelAction: vi.fn(),
    };
    const requestSign = vi.fn();
    render(<VaultRetryQueue client={client} requestSign={requestSign} />);
    await waitFor(() => screen.getByRole("button", { name: /Retry deposit/i }));
    fireEvent.click(screen.getByRole("button", { name: /Retry deposit/i }));
    await waitFor(() => expect(client.createRetryAttempt).toHaveBeenCalled());
    const [, ctx] = client.createRetryAttempt.mock.calls[0];
    expect(ctx.requestSign).toBe(requestSign);
    expect(ctx.walletAddress).toBe(WALLET);
  });

  it("cancels a pending action via the ledger client", async () => {
    connectedPublicKey.set(WALLET);
    const pending = makeRow({
      status: "pending",
      errorCode: null,
      errorDetail: null,
    });
    const client = {
      listQueueActions: vi.fn().mockResolvedValue([pending]),
      cancelAction: vi.fn().mockResolvedValue({
        action: { ...pending, status: "failed", errorCode: "USER_CANCELLED" },
        idempotent: false,
      }),
    };
    render(<VaultRetryQueue client={client} />);
    await waitFor(() => screen.getByRole("button", { name: /Cancel pending action/i }));
    fireEvent.click(screen.getByRole("button", { name: /Cancel pending action/i }));
    await waitFor(() => expect(client.cancelAction).toHaveBeenCalled());
  });

  it("reloads for the new wallet when the connected key switches", async () => {
    connectedPublicKey.set(WALLET);
    const client = {
      listQueueActions: vi
        .fn()
        .mockResolvedValueOnce([makeRow()])
        .mockResolvedValueOnce([
          makeRow({ id: "act-b", walletAddress: WALLET_B, pool: "Other Pool" }),
        ]),
    };
    render(<VaultRetryQueue client={client} />);
    await waitFor(() => screen.getByText(/USDC Yield Pool/));
    connectedPublicKey.set(WALLET_B);
    await waitFor(() => {
      expect(client.listQueueActions).toHaveBeenCalledWith(WALLET_B);
    });
  });

  it("ignores duplicate retry clicks while an attempt is in flight", async () => {
    connectedPublicKey.set(WALLET);
    let resolveRetry;
    const client = {
      listQueueActions: vi.fn().mockResolvedValue([makeRow()]),
      getAction: vi.fn().mockResolvedValue(makeRow()),
      createRetryAttempt: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRetry = resolve;
          })
      ),
    };
    render(<VaultRetryQueue client={client} />);
    await waitFor(() => screen.getByRole("button", { name: /Retry deposit/i }));
    const btn = screen.getByRole("button", { name: /Retry deposit/i });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(client.createRetryAttempt).toHaveBeenCalledTimes(1));
    // Button is disabled while busy so further clicks are a no-op.
    expect(screen.getByRole("button", { name: /Retry deposit/i })).toBeDisabled();
    resolveRetry({
      action: makeRow({ id: "act-retry", status: "pending", errorCode: null }),
      signature: null,
      parentActionId: "act-001",
    });
  });

  it.each(["retry", "cancel"])(
    "allows the first %s through the real client while blocking duplicate clicks",
    async (operation) => {
      const original = {
        id: "act-001",
        wallet_address: WALLET,
        action_type: "deposit",
        action_payload: { vault_id: "v1", amount: "500", token: "USDC" },
        status: operation === "retry" ? "failed" : "pending",
        error_code: operation === "retry" ? "WALLET_REJECTED" : null,
        retry_count: 0,
        created_at: "2026-09-24T12:00:00.000Z",
      };
      let releaseFresh;
      const freshReady = new Promise((resolve) => {
        releaseFresh = resolve;
      });
      // Exercise the production client and policy; only the ledger transport
      // is controlled so a second click can race the authoritative read.
      const fetchImpl = vi.fn(async (url, init = {}) => {
        const requestPath = new URL(url).pathname;
        let data;
        if (init.method === "POST") {
          data = operation === "retry"
            ? {
                ...original,
                id: "act-retry",
                status: "pending",
                error_code: null,
                action_payload: JSON.parse(init.body).action_payload,
              }
            : { ...original, status: "failed", error_code: "USER_CANCELLED" };
        } else if (requestPath === "/actions/act-001") {
          await freshReady;
          data = original;
        } else {
          data = [original];
        }
        return new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      const client = createRetryQueueClient({
        baseUrl: "http://ledger.test",
        fetchImpl,
        getAuthHeaders: () => ({ "X-Wallet-Address": WALLET }),
      });
      render(<VaultRetryQueue walletAddress={WALLET} client={client} />);
      const button = await screen.findByRole("button", {
        name: operation === "retry" ? "Retry deposit" : "Cancel pending action",
      });

      fireEvent.click(button);
      fireEvent.click(button);
      await waitFor(() => {
        expect(fetchImpl.mock.calls.filter(([url]) =>
          new URL(url).pathname === "/actions/act-001",
        )).toHaveLength(1);
      });
      expect(button).toBeDisabled();
      releaseFresh();

      const writes = () => fetchImpl.mock.calls.filter(([, init]) => init.method === "POST");
      await waitFor(() => expect(writes()).toHaveLength(1));
      const [url, init] = writes()[0];
      expect(init.headers["X-Wallet-Address"]).toBe(WALLET);
      if (operation === "retry") {
        expect(new URL(url).pathname).toBe("/actions");
        expect(JSON.parse(init.body).action_payload).toMatchObject({
          parent_action_id: original.id,
          retry_of: original.id,
        });
        await waitFor(() => expect(document.querySelector('[data-action-id="act-retry"]')).not.toBeNull());
      } else {
        expect(new URL(url).pathname).toBe("/actions/act-001/cancel");
        expect(JSON.parse(init.body).error_code).toBe("USER_CANCELLED");
        await waitFor(() => expect(screen.queryByRole("region", { name: "Transaction retry queue" })).toBeNull());
      }
    },
  );
  it.each([
    ["retry", "preflight", "wallet switch"],
    ["retry", "authentication", "wallet switch"],
    ["retry", "creation", "wallet switch"],
    ["cancel", "preflight", "wallet switch"],
    ["cancel", "authentication", "wallet switch"],
    ["cancel", "preflight", "unmount"],
    ["cancel", "authentication", "unmount"],
  ])(
    "retires a %s paused at %s after %s",
    async (operation, boundary, transition) => {
      const original = {
        id: "act-001",
        wallet_address: WALLET,
        action_type: "deposit",
        action_payload: {
          vault_id: "v1",
          pool_name: "Wallet A Pool",
          amount: "500",
          token: "USDC",
        },
        status: operation === "retry" ? "failed" : "pending",
        error_code: operation === "retry" ? "WALLET_REJECTED" : null,
        retry_count: 0,
        created_at: "2026-09-24T12:00:00.000Z",
      };
      const pending = deferred();
      let waiting = false;
      let activeWallet = WALLET;
      let authCalls = 0;
      const pause = async () => {
        waiting = true;
        await pending.promise;
      };
      const fetchImpl = vi.fn(async (url, init = {}) => {
        const request = new URL(url);
        let data;
        if (init.method === "POST") {
          if (boundary === "creation") await pause();
          data = operation === "retry"
            ? {
                ...original,
                id: "act-retry",
                status: "pending",
                error_code: null,
                action_payload: JSON.parse(init.body).action_payload,
              }
            : { ...original, status: "failed", error_code: "USER_CANCELLED" };
        } else if (request.pathname === "/actions/act-001") {
          if (boundary === "preflight") await pause();
          data = original;
        } else {
          data = request.searchParams.get("wallet") === WALLET
            ? [original]
            : [{
                ...original,
                id: "act-b",
                wallet_address: WALLET_B,
                action_payload: { ...original.action_payload, pool_name: "Wallet B Pool" },
              }];
        }
        return new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      const client = createRetryQueueClient({
        baseUrl: "http://ledger.test",
        fetchImpl,
        getAuthHeaders: async () => {
          // The list and authoritative read authenticate before the action POST.
          if (++authCalls === 3 && boundary === "authentication") await pause();
          return { "X-Wallet-Address": activeWallet };
        },
      });
      const requestSign = vi.fn().mockResolvedValue("explicit-user-signature");
      const { rerender, unmount, container } = render(
        <VaultRetryQueue walletAddress={WALLET} client={client} requestSign={requestSign} />,
      );
      fireEvent.click(await screen.findByRole("button", {
        name: operation === "retry" ? "Retry deposit" : "Cancel pending action",
      }));
      try {
        await waitFor(() => expect(waiting).toBe(true));
        if (transition === "unmount") {
          unmount();
        } else {
          activeWallet = WALLET_B;
          rerender(
            <VaultRetryQueue walletAddress={WALLET_B} client={client} requestSign={requestSign} />,
          );
          await screen.findByText(/Wallet B Pool/);
          activeWallet = WALLET;
          rerender(
            <VaultRetryQueue walletAddress={WALLET} client={client} requestSign={requestSign} />,
          );
          await screen.findByText(/Wallet A Pool/);
        }
      } finally {
        await act(async () => pending.resolve());
      }

      // A POST already sent cannot be recalled, but its late response must not sign.
      const writes = fetchImpl.mock.calls.filter(([, init]) => init.method === "POST");
      expect(writes).toHaveLength(boundary === "creation" ? 1 : 0);
      expect(requestSign).not.toHaveBeenCalled();
      if (transition === "unmount") expect(container).toBeEmptyDOMElement();
      else expect(screen.getByText(/Wallet A Pool/)).toBeInTheDocument();
      expect(document.querySelector('[data-action-id="act-retry"]')).toBeNull();
    },
  );

  it.each([
    ["wallet", false],
    ["client", false],
    ["wallet", true],
    ["client", true],
  ])(
    "hides previous rows in the first committed render after a %s change (collapsed: %s)",
    async (change, collapseBeforeChange) => {
      const next = deferred();
      const client = {
        listQueueActions: vi
          .fn()
          .mockResolvedValueOnce([makeRow()])
          .mockReturnValue(next.promise),
      };
      const nextClient =
        change === "client"
          ? { listQueueActions: vi.fn().mockReturnValue(next.promise) }
          : client;
      const nextWallet = change === "wallet" ? WALLET_B : WALLET;
      const commits = [];
      function ObservedQueue({ walletAddress, ledgerClient }) {
        React.useLayoutEffect(() => {
          commits.push(
            [...document.querySelectorAll("[data-action-id]")].map((row) =>
              row.getAttribute("data-action-id"),
            ),
          );
        }, [walletAddress, ledgerClient]);
        return (
          <VaultRetryQueue walletAddress={walletAddress} client={ledgerClient} />
        );
      }
      const { rerender } = render(
        <ObservedQueue walletAddress={WALLET} ledgerClient={client} />,
      );
      await screen.findByText(/USDC Yield Pool/);
      if (collapseBeforeChange) {
        const content = document.getElementById("retry-queue-content");
        const row = document.querySelector('[data-action-id="act-001"]');
        // Finish entry before starting an exit that can retain the old rows.
        await waitFor(() => {
          expect(content).toHaveStyle({ opacity: "1" });
          expect(row).toHaveStyle({ opacity: "1" });
        });
        fireEvent.click(screen.getByRole("button", { name: "Collapse queue" }));
        expect(screen.getByRole("button", { name: "Expand queue" })).toBeInTheDocument();
        expect(document.querySelector('[data-action-id="act-001"]')).toBeInTheDocument();
      }
      commits.length = 0;
      rerender(
        <ObservedQueue walletAddress={nextWallet} ledgerClient={nextClient} />,
      );
      try {
        expect(commits).toEqual([[]]);
        if (collapseBeforeChange) {
          expect(document.querySelector('[data-action-id="act-001"]')).toBeNull();
          fireEvent.click(screen.getByRole("button", { name: "Expand queue" }));
        }
        expect(
          screen.getByText(/Loading actions from the ledger/),
        ).toBeInTheDocument();
      } finally {
        await act(async () =>
          next.resolve([
            makeRow({
              id: "act-new",
              walletAddress: nextWallet,
              pool: "Current Pool",
            }),
          ]),
        );
      }
      expect(screen.getByText(/Current Pool/)).toBeInTheDocument();
    },
  );

  it.each([
    ["wallet", "success"],
    ["wallet", "failure"],
    ["client", "success"],
    ["client", "failure"],
  ])(
    "ignores a preceding %s context's late %s after current rows load",
    async (change, outcome) => {
      const old = deferred();
      const nextWallet = change === "wallet" ? WALLET_B : WALLET;
      const current = makeRow({
        id: "act-current",
        walletAddress: nextWallet,
        pool: "Current Pool",
      });
      const client = {
        listQueueActions: vi
          .fn()
          .mockReturnValueOnce(old.promise)
          .mockResolvedValue([current]),
      };
      const nextClient =
        change === "client"
          ? { listQueueActions: vi.fn().mockResolvedValue([current]) }
          : client;
      const { rerender } = render(
        <VaultRetryQueue walletAddress={WALLET} client={client} />,
      );
      await waitFor(() =>
        expect(client.listQueueActions).toHaveBeenCalledTimes(1),
      );
      rerender(
        <VaultRetryQueue walletAddress={nextWallet} client={nextClient} />,
      );
      await screen.findByText(/Current Pool/);
      await act(async () => {
        if (outcome === "failure")
          old.reject(new Error("Previous context failure"));
        else old.resolve([makeRow({ pool: "Previous Pool" })]);
      });
      expect(screen.getByText(/Current Pool/)).toBeInTheDocument();
      expect(screen.queryByText(/Previous Pool/)).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it.each(["success", "failure"])(
    "keeps the new wallet loading when an old request completes with %s",
    async (outcome) => {
      const old = deferred();
      const current = deferred();
      const client = {
        listQueueActions: vi
          .fn()
          .mockReturnValueOnce(old.promise)
          .mockReturnValueOnce(current.promise),
      };
      const { rerender } = render(
        <VaultRetryQueue walletAddress={WALLET} client={client} />,
      );
      await waitFor(() =>
        expect(client.listQueueActions).toHaveBeenCalledTimes(1),
      );
      rerender(<VaultRetryQueue walletAddress={WALLET_B} client={client} />);
      await waitFor(() =>
        expect(client.listQueueActions).toHaveBeenCalledWith(WALLET_B),
      );
      await act(async () => {
        if (outcome === "failure")
          old.reject(new Error("Previous context failure"));
        else old.resolve([makeRow()]);
      });
      try {
        expect(
          screen.getByText(/Loading actions from the ledger/),
        ).toBeInTheDocument();
        expect(document.querySelector("[data-action-id]")).toBeNull();
        expect(screen.queryByRole("alert")).toBeNull();
      } finally {
        await act(async () =>
          current.resolve([
            makeRow({
              id: "act-current",
              walletAddress: WALLET_B,
              pool: "Current Pool",
            }),
          ]),
        );
      }
      expect(screen.getByText(/Current Pool/)).toBeInTheDocument();
    },
  );

  it.each(["success", "failure"])(
    "retains the latest same-wallet refresh after an older %s",
    async (outcome) => {
      const old = deferred();
      const client = {
        listQueueActions: vi
          .fn()
          .mockResolvedValueOnce([makeRow()])
          .mockReturnValueOnce(old.promise)
          .mockResolvedValueOnce([
            makeRow({ id: "act-current", pool: "Current Pool" }),
          ]),
      };
      render(<VaultRetryQueue walletAddress={WALLET} client={client} />);
      await screen.findByText(/USDC Yield Pool/);
      const refresh = screen.getByRole("button", {
        name: "Refresh retry queue from ledger",
      });
      fireEvent.click(refresh);
      await waitFor(() =>
        expect(client.listQueueActions).toHaveBeenCalledTimes(2),
      );
      fireEvent.click(refresh);
      await screen.findByText(/Current Pool/);
      await act(async () => {
        if (outcome === "failure")
          old.reject(new Error("Previous refresh failure"));
        else old.resolve([makeRow({ id: "act-old", pool: "Previous Pool" })]);
      });
      expect(screen.getByText(/Current Pool/)).toBeInTheDocument();
      expect(screen.queryByText(/Previous Pool/)).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it.each(["retry", "cancel"])(
    "keeps old %s completion out of the new wallet's UI",
    async (operation) => {
      const old = deferred();
      const original = makeRow(
        operation === "cancel" ? { status: "pending", errorCode: null } : {},
      );
      const client = {
        listQueueActions: vi
          .fn()
          .mockResolvedValueOnce([original])
          .mockResolvedValueOnce([
            makeRow({
              id: "act-current",
              walletAddress: WALLET_B,
              pool: "Current Pool",
            }),
          ]),
        getAction: vi.fn().mockResolvedValue(original),
        createRetryAttempt: vi.fn().mockReturnValue(old.promise),
        cancelAction: vi.fn().mockReturnValue(old.promise),
      };
      const { rerender } = render(
        <VaultRetryQueue walletAddress={WALLET} client={client} />,
      );
      const button = await screen.findByRole("button", {
        name: operation === "retry" ? "Retry deposit" : "Cancel pending action",
      });
      fireEvent.click(button);
      await waitFor(() =>
        expect(
          operation === "retry" ? client.createRetryAttempt : client.cancelAction,
        ).toHaveBeenCalledTimes(1),
      );
      rerender(<VaultRetryQueue walletAddress={WALLET_B} client={client} />);
      await screen.findByText(/Current Pool/);
      await act(async () => {
        if (operation === "retry")
          old.resolve({
            action: makeRow({
              id: "act-old-retry",
              pool: "Previous Retry",
              status: "pending",
              errorCode: null,
            }),
          });
        else old.reject(new Error("Previous cancel failure"));
      });
      expect(screen.getByText(/Current Pool/)).toBeInTheDocument();
      expect(screen.queryByText(/Previous Retry/)).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(
        screen.getByRole("button", { name: "Retry deposit" }),
      ).not.toBeDisabled();
    },
  );

});
