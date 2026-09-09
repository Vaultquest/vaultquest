import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WithdrawalModal } from "./WithdrawalModal";
import type { PoolSummary, UserPosition } from "../contract/types";

const pool: PoolSummary = {
  id: "pool-1",
  name: "Weekly USDC",
  status: "open",
  tvl: "10000",
  asset: "USDC",
  participantCount: 12,
  expectedYield: "5.2% APY",
  prize: "120 USDC",
  opensAt: "2026-05-01T00:00:00Z",
  locksAt: "2026-05-08T00:00:00Z",
  drawsAt: "2026-05-09T00:00:00Z",
};

const position: UserPosition = {
  walletAddress: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  deposited: "50",
  shares: "50",
  joined: true,
};

function renderModal(onWithdraw: (amount: string) => Promise<void>, onClose = vi.fn()) {
  return render(
    <WithdrawalModal pool={pool} position={position} onWithdraw={onWithdraw} onClose={onClose} />,
  );
}

describe("WithdrawalModal", () => {
  it("walks input -> review -> broadcasting -> success on a successful withdrawal", async () => {
    const user = userEvent.setup();
    const onWithdraw = vi.fn().mockResolvedValue(undefined);
    renderModal(onWithdraw);

    await user.type(screen.getByLabelText("Amount"), "20");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Confirm withdrawal")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    expect(onWithdraw).toHaveBeenCalledWith("20");

    expect(await screen.findByText("Withdrawal successful!")).toBeInTheDocument();
  });

  it("shows an error back on the review step after a failed withdrawal, with a working retry", async () => {
    const user = userEvent.setup();
    const onWithdraw = vi
      .fn()
      .mockRejectedValueOnce(new Error("contract_error: lockup active"))
      .mockResolvedValueOnce(undefined);
    renderModal(onWithdraw);

    await user.type(screen.getByLabelText("Amount"), "20");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Confirm withdrawal" }));

    // On failure the modal returns to the review step (not a stuck
    // broadcasting state) with the error message and the same confirm
    // button available for retry.
    expect(await screen.findByText("contract_error: lockup active")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm withdrawal" })).toBeInTheDocument();
    expect(onWithdraw).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
    expect(await screen.findByText("Withdrawal successful!")).toBeInTheDocument();
    expect(onWithdraw).toHaveBeenCalledTimes(2);
  });

  it("blocks continue when the amount exceeds the deposited position", async () => {
    const user = userEvent.setup();
    renderModal(vi.fn());

    await user.type(screen.getByLabelText("Amount"), "500");
    expect(screen.getByText("Amount exceeds your deposited position")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("'Withdraw all' fills the full deposited amount", async () => {
    const user = userEvent.setup();
    renderModal(vi.fn());

    await user.click(screen.getByRole("button", { name: /Withdraw all/ }));
    expect(screen.getByLabelText("Amount")).toHaveValue(50);
  });

  it("renders network mismatch banner and disables continue button when network is mismatched", async () => {
    const user = userEvent.setup();
    const onWithdraw = vi.fn();

    render(
      <WithdrawalModal
        pool={pool}
        position={position}
        onWithdraw={onWithdraw}
        onClose={vi.fn()}
        isNetworkMismatch={true}
        connectedNetwork="mainnet"
        expectedNetwork="testnet"
      />,
    );

    const banner = screen.getByTestId("network-mismatch-banner");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent(/Network Mismatch Detected/i);
    expect(banner).toHaveTextContent(/Withdrawals are blocked/i);
    expect(screen.getByTestId("expected-network")).toHaveTextContent("Stellar Testnet (testnet)");
    expect(screen.getByTestId("actual-network")).toHaveTextContent("Stellar Mainnet (mainnet)");

    await user.type(screen.getByLabelText("Amount"), "10");
    const continueBtn = screen.getByRole("button", { name: "Continue" });
    expect(continueBtn).toBeDisabled();
    expect(continueBtn).toHaveAttribute("title", "Withdrawals blocked due to network mismatch");

    await user.click(continueBtn);
    expect(screen.queryByText("Confirm withdrawal")).not.toBeInTheDocument();
  });

  it("re-enables withdrawal flow upon network recovery", async () => {
    const user = userEvent.setup();
    const onWithdraw = vi.fn().mockResolvedValue(undefined);

    const { rerender } = render(
      <WithdrawalModal
        pool={pool}
        position={position}
        onWithdraw={onWithdraw}
        onClose={vi.fn()}
        isNetworkMismatch={true}
        connectedNetwork="mainnet"
        expectedNetwork="testnet"
      />,
    );

    expect(screen.getByTestId("network-mismatch-banner")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Amount"), "10");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();

    rerender(
      <WithdrawalModal
        pool={pool}
        position={position}
        onWithdraw={onWithdraw}
        onClose={vi.fn()}
        isNetworkMismatch={false}
        connectedNetwork="testnet"
        expectedNetwork="testnet"
      />,
    );

    expect(screen.queryByTestId("network-mismatch-banner")).not.toBeInTheDocument();
    const continueBtn = screen.getByRole("button", { name: "Continue" });
    expect(continueBtn).not.toBeDisabled();

    await user.click(continueBtn);
    expect(screen.getByText("Confirm withdrawal")).toBeInTheDocument();
    const confirmBtn = screen.getByRole("button", { name: "Confirm withdrawal" });
    expect(confirmBtn).not.toBeDisabled();

    await user.click(confirmBtn);
    expect(onWithdraw).toHaveBeenCalledWith("10");
    expect(await screen.findByText("Withdrawal successful!")).toBeInTheDocument();
  });
});
