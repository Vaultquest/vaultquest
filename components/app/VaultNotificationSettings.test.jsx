import React, { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectedPublicKey } from "@vaultquest/stellar-wallet-connect/src/core/store";
import { DEFAULT_PREFS, storageKeyForWallet } from "@/lib/notification-prefs";
import VaultNotificationSettings from "./VaultNotificationSettings";

const WALLET_A = "G".padEnd(56, "A");
const WALLET_B = "G".padEnd(56, "B");
const SIGNATURE = btoa(String.fromCharCode(...new Uint8Array(64).fill(171)));
const record = (wallet, prefs = {}, revision = 1) => ({
  version: 1, wallet, prefs: { ...DEFAULT_PREFS, ...prefs }, updatedAt: 1000, revision,
});
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const signer = vi.fn(async (_, { address }) => ({ signedMessage: SIGNATURE, signerAddress: address }));

async function load() {
  fireEvent.click(screen.getByRole("button", { name: "Load saved preferences" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save Preferences" })).toBeEnabled());
}

describe("VaultNotificationSettings", () => {
  beforeEach(() => {
    localStorage.clear();
    signer.mockClear();
    connectedPublicKey.set(WALLET_A);
  });
  afterEach(() => {
    cleanup();
    connectedPublicKey.set("");
  });

  it("requires a user action to sign and confirms the server save before updating the browser copy", async () => {
    let finishSave;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ data: record(WALLET_A) }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
    render(<StrictMode><VaultNotificationSettings signMessage={signer} fetchImpl={fetchImpl} /></StrictMode>);
    expect(signer).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save Preferences" })).toBeDisabled();
    await load();
    fireEvent.click(screen.getByRole("checkbox", { name: "Deposit Confirmations" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Preferences" }));
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Notification preferences saved/)).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(storageKeyForWallet(WALLET_A))).prefs.deposits).toBe(false);
    await act(async () => finishSave(response({ data: record(WALLET_A, { deposits: true }, 2) })));
    expect(await screen.findByText(/Notification preferences saved/)).toBeVisible();
    expect(JSON.parse(localStorage.getItem(storageKeyForWallet(WALLET_A))).prefs.deposits).toBe(true);
    expect(screen.getByRole("checkbox", { name: /Security notices/ })).toBeDisabled();
  });

  it("preserves the server-backed browser copy when a save fails", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ data: record(WALLET_A) }))
      .mockResolvedValueOnce(response({ error: { message: "Service unavailable" } }, 503));
    render(<VaultNotificationSettings signMessage={signer} fetchImpl={fetchImpl} />);
    await load();
    fireEvent.click(screen.getByRole("checkbox", { name: "Deposit Confirmations" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Preferences" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Service unavailable");
    expect(screen.queryByText(/Notification preferences saved/)).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(storageKeyForWallet(WALLET_A))).prefs.deposits).toBe(false);
  });

  it("ignores an old wallet's late response after another wallet loads", async () => {
    let finishFirstLoad;
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirstLoad = resolve; }))
      .mockResolvedValueOnce(response({ data: record(WALLET_B, { winnings: false }) }));
    render(<VaultNotificationSettings signMessage={signer} fetchImpl={fetchImpl} />);
    fireEvent.click(screen.getByRole("button", { name: "Load saved preferences" }));
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    act(() => connectedPublicKey.set(WALLET_B));
    await load();
    expect(screen.getByRole("checkbox", { name: "Prize Claim Notifications" })).not.toBeChecked();
    await act(async () => finishFirstLoad(response({ data: record(WALLET_A, { winnings: true, deposits: true }) })));
    expect(screen.getByRole("checkbox", { name: "Prize Claim Notifications" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Deposit Confirmations" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Save Preferences" })).toBeEnabled();
    expect(localStorage.getItem(storageKeyForWallet(WALLET_A))).toBeNull();
  });

  it("keeps unsaved choices visible after a concurrent update and requires an explicit reload", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ data: record(WALLET_A) }))
      .mockResolvedValueOnce(response({ error: { message: "Preferences changed" } }, 409));
    render(<VaultNotificationSettings signMessage={signer} fetchImpl={fetchImpl} />);
    await load();
    fireEvent.click(screen.getByRole("checkbox", { name: "Deposit Confirmations" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Preferences" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Preferences changed elsewhere");
    expect(screen.getByRole("checkbox", { name: "Deposit Confirmations" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Save Preferences" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Load saved preferences" })).toBeEnabled();
  });

  it("can save to the server when browser storage is blocked", async () => {
    const blockedStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ data: record(WALLET_A) }))
      .mockResolvedValueOnce(response({ data: record(WALLET_A, { deposits: true }, 2) }));
    render(<VaultNotificationSettings storage={blockedStorage} signMessage={signer} fetchImpl={fetchImpl} />);
    await load();
    fireEvent.click(screen.getByRole("checkbox", { name: "Deposit Confirmations" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Preferences" }));
    expect(await screen.findByText(/Notification preferences saved/)).toBeVisible();
    expect(screen.getByText(/this browser could not cache/)).toBeVisible();
  });
});
