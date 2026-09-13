import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import VaultNotificationSettings from "./VaultNotificationSettings";
import {
  DEFAULT_PREFERENCES,
  KEY_PREFIX,
  getNotificationPreferences,
  saveNotificationPreferences,
  shouldDeliverNotification,
} from "@/lib/notificationPreferences";
import { connectedPublicKey } from "@vaultquest/stellar-wallet-connect/src/core/store";

const mockWagmi = vi.hoisted(() => ({
  useAccount: vi.fn(() => ({ address: undefined })),
}));

vi.mock("wagmi", () => mockWagmi);

const WALLET_A = "GA2W3B4C5D6E7F8G9H0J1K2L3M4N5P6Q7R8S9T0U1V2W3X4Y5Z6A7B8C";
const WALLET_B = "GB9Y8X7W6V5U4T3S2R1Q0P9N8M7L6K5J4H3G2F1E0D9C8B7A6Z5Y4X3W";

describe("VaultNotificationSettings (#118)", () => {
  beforeEach(() => {
    localStorage.clear();
    connectedPublicKey.set("");
    mockWagmi.useAccount.mockReturnValue({ address: undefined });
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("renders with default preferences when a new wallet is connected", () => {
    connectedPublicKey.set(WALLET_A);

    render(<VaultNotificationSettings />);

    expect(screen.getByText("Notification Preferences")).toBeInTheDocument();
    expect(screen.getByTestId("active-wallet-badge")).toBeInTheDocument();

    const roundCheckbox = screen.getByRole("checkbox", { name: "Round Updates" });
    const actionCheckbox = screen.getByRole("checkbox", { name: "Action Status Updates" });
    const winningsCheckbox = screen.getByRole("checkbox", { name: "Winning Notifications" });
    const depositsCheckbox = screen.getByRole("checkbox", { name: "Deposit Confirmations" });

    expect(roundCheckbox).toBeChecked();
    expect(actionCheckbox).toBeChecked();
    expect(winningsCheckbox).toBeChecked();
    expect(depositsCheckbox).not.toBeChecked();
  });

  it("displays mandatory security notices as permanently checked and disabled", () => {
    render(<VaultNotificationSettings walletAddress={WALLET_A} />);

    expect(screen.getByText("Mandatory Security Notices")).toBeInTheDocument();
    expect(screen.getByText("Always Active")).toBeInTheDocument();

    const securityNotice = screen.getByRole("checkbox", {
      name: "Security & Emergency Notices (mandatory)",
    });
    const signerNotice = screen.getByRole("checkbox", {
      name: "Signer & Auth Modifications (mandatory)",
    });

    expect(securityNotice).toBeChecked();
    expect(securityNotice).toBeDisabled();

    expect(signerNotice).toBeChecked();
    expect(signerNotice).toBeDisabled();
  });

  it("saves modified preferences scoped to the wallet address in localStorage", async () => {
    render(<VaultNotificationSettings walletAddress={WALLET_A} />);

    const depositsCheckbox = screen.getByRole("checkbox", { name: "Deposit Confirmations" });
    const roundCheckbox = screen.getByRole("checkbox", { name: "Round Updates" });

    // Toggle deposits ON, round updates OFF
    fireEvent.click(depositsCheckbox);
    fireEvent.click(roundCheckbox);

    expect(depositsCheckbox).toBeChecked();
    expect(roundCheckbox).not.toBeChecked();

    const saveButton = screen.getByRole("button", { name: "Save Preferences" });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Preferences saved for GA2W...7B8C");
    });

    // Verify localStorage key and payload
    const storageKey = `${KEY_PREFIX}${WALLET_A.toLowerCase()}`;
    const rawData = localStorage.getItem(storageKey);
    expect(rawData).not.toBeNull();

    const parsed = JSON.parse(rawData);
    expect(parsed.version).toBe(1);
    expect(parsed.walletAddress).toBe(WALLET_A);
    expect(parsed.categories.deposits).toBe(true);
    expect(parsed.categories.roundUpdates).toBe(false);
    expect(parsed.categories.actionStatus).toBe(true);
    expect(parsed.categories.winnings).toBe(true);
  });

  it("isolates preferences between different wallets during wallet switching", async () => {
    // Save custom preferences for Wallet A
    saveNotificationPreferences(WALLET_A, {
      roundUpdates: false,
      actionStatus: false,
      winnings: false,
      deposits: true,
    });

    const { rerender } = render(<VaultNotificationSettings walletAddress={WALLET_A} />);

    // Wallet A has its custom settings
    expect(screen.getByRole("checkbox", { name: "Round Updates" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Deposit Confirmations" })).toBeChecked();

    // Switch to Wallet B (which has no custom settings yet)
    rerender(<VaultNotificationSettings walletAddress={WALLET_B} />);

    // Wallet B should load default preferences, completely untouched by Wallet A
    expect(screen.getByRole("checkbox", { name: "Round Updates" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Deposit Confirmations" })).not.toBeChecked();

    // Switch back to Wallet A
    rerender(<VaultNotificationSettings walletAddress={WALLET_A} />);

    // Wallet A's custom preferences are intact
    expect(screen.getByRole("checkbox", { name: "Round Updates" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Deposit Confirmations" })).toBeChecked();
  });

  it("shows disconnected state and prevents persistence when no wallet is connected", () => {
    render(<VaultNotificationSettings />);

    expect(screen.getByTestId("no-wallet-badge")).toHaveTextContent("Wallet disconnected");
    expect(
      screen.getByText(/Connect your wallet to persist preferences across sessions/i)
    ).toBeInTheDocument();

    const saveButton = screen.getByRole("button", { name: "Save Preferences" });
    fireEvent.click(saveButton);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Connect your wallet first to persist notification preferences."
    );
  });

  it("recovers gracefully from corrupted JSON in localStorage", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const storageKey = `${KEY_PREFIX}${WALLET_A.toLowerCase()}`;
    localStorage.setItem(storageKey, "{invalid-json");

    // Reading preferences directly should not throw and return defaults
    const prefs = getNotificationPreferences(WALLET_A);
    expect(prefs).toEqual(DEFAULT_PREFERENCES);

    // Component should render cleanly without throwing
    expect(() => render(<VaultNotificationSettings walletAddress={WALLET_A} />)).not.toThrow();
    warnSpy.mockRestore();
  });

  it("enforces mandatory security delivery via shouldDeliverNotification predicate", () => {
    // Wallet has all optional notifications turned OFF
    saveNotificationPreferences(WALLET_A, {
      roundUpdates: false,
      actionStatus: false,
      winnings: false,
      deposits: false,
    });

    // Optional categories return false
    expect(shouldDeliverNotification(WALLET_A, "roundUpdates")).toBe(false);
    expect(shouldDeliverNotification(WALLET_A, "deposits")).toBe(false);
    expect(shouldDeliverNotification(WALLET_A, "winnings")).toBe(false);

    // Security & emergency notices ALWAYS deliver
    expect(shouldDeliverNotification(WALLET_A, "securityAlerts")).toBe(true);
    expect(shouldDeliverNotification(WALLET_A, "signerModifications")).toBe(true);
    expect(shouldDeliverNotification(WALLET_A, "roundUpdates", true)).toBe(true); // isSecurityAlert flag override
  });
});
