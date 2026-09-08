import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DelayedWithdrawalTracker } from "./DelayedWithdrawalTracker";
import type { DelayedWithdrawalRequest } from "../contract/types";

const mockRequests: DelayedWithdrawalRequest[] = [
  {
    requestId: 1,
    poolId: "pool-1",
    owner: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    destination: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    sharesBurned: "50",
    assetsOwed: "50",
    assetsPaid: "0",
    assetsClaimed: "0",
    claimableAssets: "0",
    remainingAssets: "50",
    queueState: "pending",
    positionInQueue: 2,
    requestedLedger: 100,
    canCancel: true,
  },
  {
    requestId: 2,
    poolId: "pool-1",
    owner: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    destination: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    sharesBurned: "30",
    assetsOwed: "30",
    assetsPaid: "30",
    assetsClaimed: "0",
    claimableAssets: "30",
    remainingAssets: "0",
    queueState: "ready",
    positionInQueue: 0,
    requestedLedger: 90,
    canCancel: false,
  },
  {
    requestId: 3,
    poolId: "pool-1",
    owner: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    destination: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    sharesBurned: "20",
    assetsOwed: "20",
    assetsPaid: "20",
    assetsClaimed: "20",
    claimableAssets: "0",
    remainingAssets: "0",
    queueState: "fulfilled",
    positionInQueue: 0,
    requestedLedger: 80,
    canCancel: false,
  },
  {
    requestId: 4,
    poolId: "pool-1",
    owner: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    destination: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    sharesBurned: "15",
    assetsOwed: "15",
    assetsPaid: "0",
    assetsClaimed: "0",
    claimableAssets: "0",
    remainingAssets: "15",
    queueState: "failed",
    positionInQueue: 0,
    requestedLedger: 70,
    canCancel: false,
  },
];

describe("DelayedWithdrawalTracker", () => {
  it("renders nothing when requests array is empty", () => {
    const { container } = render(
      <DelayedWithdrawalTracker requests={[]} assetDisplayName="USDC" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders all requests with correct state badges and queue positions", () => {
    render(
      <DelayedWithdrawalTracker requests={mockRequests} assetDisplayName="USDC" />,
    );

    expect(screen.getByText("Delayed Strategy Withdrawals")).toBeInTheDocument();
    expect(screen.getByText("4 Requests")).toBeInTheDocument();

    expect(screen.getByText("Pending Liquidity")).toBeInTheDocument();
    expect(screen.getByText("Queue Position: #3")).toBeInTheDocument();

    expect(screen.getAllByText("Ready to Claim").length).toBeGreaterThan(0);
    expect(screen.getByText("Fulfilled")).toBeInTheDocument();
    expect(screen.getByText("Failed / Cancelled")).toBeInTheDocument();
  });

  it("calls onCancel when clicking Cancel Request on pending withdrawal", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn().mockResolvedValue(undefined);

    render(
      <DelayedWithdrawalTracker
        requests={[mockRequests[0]]}
        assetDisplayName="USDC"
        onCancel={onCancel}
      />,
    );

    const cancelButton = screen.getByRole("button", {
      name: "Cancel withdrawal request #1",
    });
    await user.click(cancelButton);

    expect(onCancel).toHaveBeenCalledWith(1);
  });

  it("calls onClaim when clicking Claim Liquidity on ready withdrawal", async () => {
    const user = userEvent.setup();
    const onClaim = vi.fn().mockResolvedValue(undefined);

    render(
      <DelayedWithdrawalTracker
        requests={[mockRequests[1]]}
        assetDisplayName="USDC"
        onClaim={onClaim}
      />,
    );

    const claimButton = screen.getByRole("button", {
      name: /Claim.*USDC.*request #2/i,
    });
    await user.click(claimButton);

    expect(onClaim).toHaveBeenCalledWith(2);
  });

  it("displays an action error message if claiming fails", async () => {
    const user = userEvent.setup();
    const onClaim = vi.fn().mockRejectedValue(new Error("RPC submission timeout"));

    render(
      <DelayedWithdrawalTracker
        requests={[mockRequests[1]]}
        assetDisplayName="USDC"
        onClaim={onClaim}
      />,
    );

    const claimButton = screen.getByRole("button", {
      name: /Claim.*USDC.*request #2/i,
    });
    await user.click(claimButton);

    expect(await screen.findByText("RPC submission timeout")).toBeInTheDocument();
  });
});
