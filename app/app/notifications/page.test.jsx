import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectedPublicKey } from "@/stellar-wallet-connect/src/core/store";
import { requestWalletNotification } from "@/lib/notification-prefs-client";
import VaultNotificationsPage from "./page";

vi.mock("@/lib/notification-prefs-client", () => ({ requestWalletNotification: vi.fn() }));
const WALLET_A = "G".padEnd(56, "A");
const WALLET_B = "G".padEnd(56, "B");
const notice = title => ({ id: title, title, message: "Recorded action outcome", date: "2026-10-03T00:00:00Z", type: "action", status: "unread" });

describe("wallet notification history", () => {
  beforeEach(() => { connectedPublicKey.set(""); vi.mocked(requestWalletNotification).mockReset(); });
  afterEach(() => { cleanup(); connectedPublicKey.set(""); });

  it("shows an empty state without requesting signatures or inventing sample notices", () => {
    render(<VaultNotificationsPage />);
    expect(screen.getByRole("button", { name: "Load notifications" })).toBeDisabled();
    expect(screen.getByText("No notifications to show")).toBeVisible();
    expect(requestWalletNotification).not.toHaveBeenCalled();
  });

  it("loads only the connected wallet's server history after an explicit action", async () => {
    connectedPublicKey.set(WALLET_A);
    vi.mocked(requestWalletNotification).mockResolvedValue({ data: [notice("Withdrawal confirmed")] });
    render(<VaultNotificationsPage />);
    expect(requestWalletNotification).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Load notifications" }));
    expect(await screen.findByText("Withdrawal confirmed")).toBeVisible();
    expect(requestWalletNotification).toHaveBeenCalledWith(`/api/notifications?wallet=${WALLET_A}`, expect.objectContaining({ wallet: WALLET_A, signal: expect.any(AbortSignal) }));
    fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
    fireEvent.click(screen.getByRole("button", { name: "Unread only" }));
    expect(screen.queryByText("Withdrawal confirmed")).not.toBeInTheDocument();
  });

  it("ignores an old wallet's late history response after switching wallets", async () => {
    let finishOld;
    connectedPublicKey.set(WALLET_A);
    vi.mocked(requestWalletNotification)
      .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
      .mockResolvedValueOnce({ data: [notice("Current wallet notice")] });
    render(<VaultNotificationsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Load notifications" }));
    await waitFor(() => expect(requestWalletNotification).toHaveBeenCalledTimes(1));
    act(() => connectedPublicKey.set(WALLET_B));
    fireEvent.click(screen.getByRole("button", { name: "Load notifications" }));
    expect(await screen.findByText("Current wallet notice")).toBeVisible();
    await act(async () => finishOld({ data: [notice("Old wallet notice")] }));
    expect(screen.queryByText("Old wallet notice")).not.toBeInTheDocument();
    expect(screen.getByText("Current wallet notice")).toBeVisible();
  });
});
