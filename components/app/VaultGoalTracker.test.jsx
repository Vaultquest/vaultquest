import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectedPublicKey } from "@vaultquest/stellar-wallet-connect/src/core/store";
import VaultGoalTracker from "./VaultGoalTracker";
import { goalStorageKey } from "@/lib/vault-goals-storage";

// #119 regression suite. The tracker used to read one browser-wide key, so a
// second wallet in the same browser saw (and could overwrite) the first
// wallet's target, and a failed save still reported success.

const WALLET_A = "GA".padEnd(56, "A");
const WALLET_B = "GB".padEnd(56, "B");

function setWallet(key) {
  act(() => {
    connectedPublicKey.set(key);
  });
}

function storedGoal(wallet, amount) {
  return JSON.stringify({
    version: 2,
    wallet,
    amount,
    createdAt: 1,
    updatedAt: 1,
  });
}

beforeEach(() => {
  window.localStorage.clear();
  setWallet("");
});

afterEach(() => {
  vi.restoreAllMocks();
  setWallet("");
  window.localStorage.clear();
});

describe("VaultGoalTracker wallet scoping", () => {
  it("asks for a wallet instead of reading a global goal", () => {
    window.localStorage.setItem("vq_goal_tracker", JSON.stringify({ amount: 9999, createdAt: 1 }));
    render(<VaultGoalTracker currentBalance={0} />);
    expect(screen.getByText("Connect a wallet to track a goal")).toBeInTheDocument();
    expect(screen.queryByText(/$9,999/)).not.toBeInTheDocument();
  });

  it("shows the connected wallet's own goal", async () => {
    window.localStorage.setItem(goalStorageKey(WALLET_A), storedGoal(WALLET_A, 5000));
    setWallet(WALLET_A);
    render(<VaultGoalTracker currentBalance={1250} />);

    await waitFor(() => expect(screen.getByText("$5,000")).toBeInTheDocument());
  });

  it("hides the previous wallet's goal when the wallet switches", async () => {
    window.localStorage.setItem(goalStorageKey(WALLET_A), storedGoal(WALLET_A, 5000));
    setWallet(WALLET_A);
    render(<VaultGoalTracker currentBalance={0} />);
    await waitFor(() => expect(screen.getByText("$5,000")).toBeInTheDocument());

    setWallet(WALLET_B);
    await waitFor(() => expect(screen.getByText("No savings goal set")).toBeInTheDocument());
    expect(screen.queryByText("$5,000")).not.toBeInTheDocument();
  });

  it("writes a new goal under the wallet-scoped key", async () => {
    const user = userEvent.setup();
    setWallet(WALLET_A);
    render(<VaultGoalTracker currentBalance={0} />);

    await user.click(await screen.findByRole("button", { name: /set savings goal/i }));
    await user.type(screen.getByLabelText("Set savings goal amount"), "750");
    await user.click(screen.getByRole("button", { name: /set goal/i }));

    await waitFor(() => expect(screen.getByText("$750")).toBeInTheDocument());
    const stored = window.localStorage.getItem(goalStorageKey(WALLET_A));
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored).wallet).toBe(WALLET_A.toLowerCase());
    expect(window.localStorage.getItem("vq_goal_tracker")).toBeNull();
  });

  it("reports a failed save instead of pretending it worked", async () => {
    const user = userEvent.setup();
    setWallet(WALLET_A);
    render(<VaultGoalTracker currentBalance={0} />);

    await user.click(await screen.findByRole("button", { name: /set savings goal/i }));
    await user.type(screen.getByLabelText("Set savings goal amount"), "750");

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    await user.click(screen.getByRole("button", { name: /set goal/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent(/refused to store/i);
  });

  it("surfaces unreadable stored data instead of showing the empty state", async () => {
    window.localStorage.setItem(goalStorageKey(WALLET_A), "{not json");
    setWallet(WALLET_A);
    render(<VaultGoalTracker currentBalance={0} />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent(/not readable/i);
  });

  it("keeps the two wallets independent when both have goals", async () => {
    window.localStorage.setItem(goalStorageKey(WALLET_A), storedGoal(WALLET_A, 5000));
    window.localStorage.setItem(goalStorageKey(WALLET_B), storedGoal(WALLET_B, 900));
    setWallet(WALLET_A);
    render(<VaultGoalTracker currentBalance={0} />);
    await waitFor(() => expect(screen.getByText("$5,000")).toBeInTheDocument());

    setWallet(WALLET_B);
    await waitFor(() => expect(screen.getByText("$900")).toBeInTheDocument());
    expect(screen.queryByText("$5,000")).not.toBeInTheDocument();
  });
});
