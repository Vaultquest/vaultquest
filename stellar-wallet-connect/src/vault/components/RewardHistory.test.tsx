import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RewardHistory } from "./RewardHistory";
import type { RewardHistoryEntry } from "../contract/types";

const baseEntry: RewardHistoryEntry = {
  id: "r1",
  poolId: "pool-1",
  poolName: "Weekly USDC",
  cycleEndedAt: "2026-05-09T00:00:00Z",
  rewardAmount: "42",
  asset: "USDC",
  status: "won",
  winnerAddress: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  txHash: "txhash123456789",
  drawProof: {
    roundId: "42",
    txHash: "txhash123456789",
    proof: "draw-proof-digest-1",
    verified: true,
  },
};

const entries: RewardHistoryEntry[] = [baseEntry];

describe("RewardHistory", () => {
  it("prompts to connect when the wallet is disconnected", () => {
    render(<RewardHistory entries={null} walletConnected={false} />);
    expect(screen.getByText(/wallet not connected/i)).toBeInTheDocument();
  });

  it("shows a loading state", () => {
    render(<RewardHistory entries={null} loading />);
    expect(screen.getAllByText(/loading reward history/i).length).toBeGreaterThan(0);
  });

  it("shows an empty state when there are no completed cycles", () => {
    render(<RewardHistory entries={[]} />);
    expect(screen.getByText(/no completed cycles yet/i)).toBeInTheDocument();
  });

  it("shows an error state with a retry affordance", () => {
    render(<RewardHistory entries={null} error="boom" onRetry={() => {}} />);
    expect(screen.getByText(/couldn't load reward history/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("renders rows with truncated winner address and an explorer link", () => {
    render(<RewardHistory entries={entries} />);
    expect(screen.getAllByText("Weekly USDC").length).toBeGreaterThan(0);
    // Truncated, privacy-aware address (never the full string).
    expect(screen.getAllByText("GBBD47…FLA5").length).toBeGreaterThan(0);
    expect(screen.queryByText(entries[0].winnerAddress as string)).not.toBeInTheDocument();
    const links = screen.getAllByRole("link");
    expect(links[0]).toHaveAttribute("href", expect.stringContaining("/tx/txhash123456789"));
  });

  it("shows the originating draw round for a verified proof", () => {
    render(<RewardHistory entries={entries} />);
    expect(screen.getAllByText(/Round 42/i).length).toBeGreaterThan(0);
  });

  it("renders a claimed reward with its round id and tx provenance", () => {
    const claimed: RewardHistoryEntry[] = [
      { ...baseEntry, id: "r2", status: "claimed", txHash: "clmhash0001", drawProof: { roundId: "43", txHash: "clmhash0001", proof: "proof-2", verified: true } },
    ];
    render(<RewardHistory entries={claimed} />);
    expect(screen.getAllByText(/Claimed/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Round 43/i).length).toBeGreaterThan(0);
    const links = screen.getAllByRole("link");
    expect(links[0]).toHaveAttribute("href", expect.stringContaining("/tx/clmhash0001"));
  });

  it("renders a failed claim", () => {
    const failed: RewardHistoryEntry[] = [
      { ...baseEntry, id: "r3", status: "failed", txHash: "failhash0001", drawProof: { roundId: "44", txHash: "failhash0001", proof: "proof-3", verified: true } },
    ];
    render(<RewardHistory entries={failed} />);
    expect(screen.getAllByText(/Failed/i).length).toBeGreaterThan(0);
  });

  it("flags a disputed reward when the proof does not reconcile", () => {
    const disputed: RewardHistoryEntry[] = [
      { ...baseEntry, id: "r4", status: "disputed", drawProof: { roundId: "45", txHash: "mismatch0001", proof: "proof-4", verified: false } },
    ];
    render(<RewardHistory entries={disputed} />);
    expect(screen.getAllByText(/Disputed/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Round 45 · disputed/i).length).toBeGreaterThan(0);
  });

  it("flags an entry with no draw proof", () => {
    const noProof: RewardHistoryEntry[] = [
      { ...baseEntry, id: "r5", status: "claimed", drawProof: null },
    ];
    render(<RewardHistory entries={noProof} />);
    expect(screen.getAllByText(/No proof/i).length).toBeGreaterThan(0);
  });

  it("disables claim buttons and displays network mismatch banner when network is mismatched", async () => {
    const onClaim = vi.fn();
    const claimable: RewardHistoryEntry[] = [
      { ...baseEntry, id: "r6", status: "won", txHash: null },
    ];

    render(
      <RewardHistory
        entries={claimable}
        onClaim={onClaim}
        isNetworkMismatch={true}
        connectedNetwork="mainnet"
        expectedNetwork="testnet"
      />,
    );

    const banner = screen.getByTestId("network-mismatch-banner");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent(/Network Mismatch Detected/i);
    expect(banner).toHaveTextContent(/Reward claims are blocked/i);
    expect(screen.getByTestId("expected-network")).toHaveTextContent("Stellar Testnet (testnet)");
    expect(screen.getByTestId("actual-network")).toHaveTextContent("Stellar Mainnet (mainnet)");

    const claimButtons = screen.getAllByRole("button", { name: /Claim/i });
    expect(claimButtons.length).toBeGreaterThan(0);
    claimButtons.forEach((btn) => {
      expect(btn).toBeDisabled();
    });
  });

  it("enables claim buttons when network is matching and allows claiming", async () => {
    const user = userEvent.setup();
    const onClaim = vi.fn();
    const claimable: RewardHistoryEntry[] = [
      { ...baseEntry, id: "r7", status: "won", txHash: null },
    ];

    const { rerender } = render(
      <RewardHistory
        entries={claimable}
        onClaim={onClaim}
        isNetworkMismatch={true}
        connectedNetwork="mainnet"
        expectedNetwork="testnet"
      />,
    );

    expect(screen.getByTestId("network-mismatch-banner")).toBeInTheDocument();

    rerender(
      <RewardHistory
        entries={claimable}
        onClaim={onClaim}
        isNetworkMismatch={false}
        connectedNetwork="testnet"
        expectedNetwork="testnet"
      />,
    );

    expect(screen.queryByTestId("network-mismatch-banner")).not.toBeInTheDocument();
    const claimButton = screen.getAllByRole("button", { name: "Claim" })[0];
    expect(claimButton).not.toBeDisabled();
    await user.click(claimButton);
    expect(onClaim).toHaveBeenCalledWith(claimable[0]);
  });
});
