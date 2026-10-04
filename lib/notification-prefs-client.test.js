import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS } from "./notification-prefs";
import {
  loadNotificationPreferences,
  requestWalletNotification,
  saveNotificationPreferences,
} from "./notification-prefs-client";

const WALLET = "G".padEnd(56, "A");
const OTHER_WALLET = "G".padEnd(56, "B");
const HEX_SIGNATURE = "ab".repeat(64);
const SIGNATURE = btoa(String.fromCharCode(...new Uint8Array(64).fill(171)));
const record = { version: 1, wallet: WALLET, prefs: { ...DEFAULT_PREFS }, revision: 2, updatedAt: 1000 };
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

describe("wallet notification requests", () => {
  it("signs the existing challenge, normalizes hex, and consumes distinct challenges for concurrent reads", async () => {
    const signMessage = vi.fn(async () => ({ signedMessage: HEX_SIGNATURE, signerAddress: WALLET }));
    const fetchImpl = vi.fn(async () => response({ data: record }));
    await Promise.all([
      loadNotificationPreferences(WALLET, { signMessage, fetchImpl }),
      loadNotificationPreferences(WALLET, { signMessage, fetchImpl }),
    ]);
    const timestamps = fetchImpl.mock.calls.map(([, init]) => init.headers["x-wallet-timestamp"]);
    expect(new Set(timestamps).size).toBe(2);
    for (const [index, [, init]] of fetchImpl.mock.calls.entries()) {
      expect(init.headers["x-wallet-address"]).toBe(WALLET);
      expect(init.headers["x-wallet-signature"]).toBe(SIGNATURE);
      expect(init.cache).toBe("no-store");
      expect(signMessage.mock.calls[index]).toEqual([
        `vaultquest:actions-export:${WALLET}:${timestamps[index]}`,
        { address: WALLET },
      ]);
    }
  });

  it("sends the loaded revision and preserves a base64 wallet signature on save", async () => {
    const signMessage = vi.fn(async () => ({ signedMessage: SIGNATURE, signerAddress: WALLET }));
    const fetchImpl = vi.fn(async () => response({ data: { ...record, revision: 3 } }));
    const saved = await saveNotificationPreferences(WALLET, { ...DEFAULT_PREFS, deposits: true }, 2, { signMessage, fetchImpl });
    expect(saved.revision).toBe(3);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/notification-prefs");
    expect(init.method).toBe("PUT");
    expect(init.headers["x-wallet-signature"]).toBe(SIGNATURE);
    expect(JSON.parse(init.body)).toEqual({ wallet_address: WALLET, expectedRevision: 2, prefs: { ...DEFAULT_PREFS, deposits: true } });
  });

  it("does not send when signing returns another wallet", async () => {
    const fetchImpl = vi.fn();
    await expect(loadNotificationPreferences(WALLET, {
      signMessage: async () => ({ signedMessage: SIGNATURE, signerAddress: OTHER_WALLET }), fetchImpl,
    })).rejects.toThrow(/signing wallet changed/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not send a wallet request cancelled while the signature dialog is open", async () => {
    const controller = new AbortController();
    let finishSigning;
    const fetchImpl = vi.fn();
    const pending = requestWalletNotification("/api/notifications", {
      wallet: WALLET,
      signal: controller.signal,
      fetchImpl,
      signMessage: () => new Promise((resolve) => { finishSigning = resolve; }),
    });
    controller.abort();
    finishSigning({ signedMessage: SIGNATURE, signerAddress: WALLET });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not accept an HTTP 200 response for the wrong wallet as a saved record", async () => {
    await expect(saveNotificationPreferences(WALLET, DEFAULT_PREFS, 2, {
      signMessage: async () => ({ signedMessage: SIGNATURE }),
      fetchImpl: async () => response({ data: { ...record, wallet: OTHER_WALLET } }),
    })).rejects.toThrow(/did not confirm valid preferences/i);
  });

  it("preserves a conflict status for the form to reconcile rather than retrying the write", async () => {
    const fetchImpl = vi.fn(async () => response({ error: { message: "Preferences changed" } }, 409));
    await expect(saveNotificationPreferences(WALLET, DEFAULT_PREFS, 2, {
      signMessage: async () => ({ signedMessage: SIGNATURE }), fetchImpl,
    })).rejects.toMatchObject({ status: 409 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
