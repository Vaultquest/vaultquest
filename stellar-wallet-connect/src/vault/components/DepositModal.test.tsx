import { describe, it, expect, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DepositModal } from "./DepositModal";
import type { PoolSummary } from "../contract/types";

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

function renderModal(onDeposit: (amount: string) => Promise<void>, onClose = vi.fn()) {
  return render(
    <DepositModal pool={pool} walletBalance="100" onDeposit={onDeposit} onClose={onClose} />,
  );
}

describe("DepositModal", () => {
  it("walks input -> review -> broadcasting -> success on a successful deposit", async () => {
    const user = userEvent.setup();
    const onDeposit = vi.fn().mockResolvedValue(undefined);
    renderModal(onDeposit);

    await user.type(screen.getByLabelText("Amount"), "10");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Confirm deposit")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Confirm deposit" }));
    expect(onDeposit).toHaveBeenCalledWith("10");

    expect(await screen.findByText("Deposit successful!")).toBeInTheDocument();
  });

  it("shows an error back on the review step after a failed deposit, with a working retry", async () => {
    const user = userEvent.setup();
    const onDeposit = vi
      .fn()
      .mockRejectedValueOnce(new Error("rpc failed: try again"))
      .mockResolvedValueOnce(undefined);
    renderModal(onDeposit);

    await user.type(screen.getByLabelText("Amount"), "10");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Confirm deposit" }));

    // On failure the modal returns to the review step (not a stuck
    // broadcasting state) with the error message and the same confirm
    // button available for retry.
    expect(await screen.findByText("rpc failed: try again")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm deposit" })).toBeInTheDocument();
    expect(onDeposit).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Confirm deposit" }));
    expect(await screen.findByText("Deposit successful!")).toBeInTheDocument();
    // Retry re-invoked onDeposit rather than reusing a stale result.
    expect(onDeposit).toHaveBeenCalledTimes(2);
  });

  it("blocks continue and shows a validation error for an empty amount", async () => {
    const user = userEvent.setup();
    const onDeposit = vi.fn();
    renderModal(onDeposit);

    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    onDeposit.mockClear();

    await user.click(screen.getByRole("button", { name: "Max" }));
    await user.clear(screen.getByLabelText("Amount"));
    await user.type(screen.getByLabelText("Amount"), "0");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("rejects an amount exceeding the available balance (leaving the gas buffer)", async () => {
    const user = userEvent.setup();
    renderModal(vi.fn());

    await user.type(screen.getByLabelText("Amount"), "99.9");
    expect(screen.getByText(/Amount exceeds available balance/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("disables modal close while broadcasting to avoid navigating away mid-transaction", async () => {
    const user = userEvent.setup();
    let resolveDeposit!: () => void;
    const onDeposit = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => { resolveDeposit = resolve; }),
    );
    renderModal(onDeposit);

    await user.type(screen.getByLabelText("Amount"), "10");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Confirm deposit" }));

    expect(await screen.findByText("Broadcasting deposit...")).toBeInTheDocument();
    await act(async () => {
      resolveDeposit();
      await Promise.resolve();
    });
  });
});
