import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DepositModal from "./DepositModal";

describe("DepositModal Component", () => {
  const baseSnapshot = {
    total_shares: 10_000_000_000n,
    total_assets: 10_000_000_000n,
    pending_withdrawals: 0n,
    accrued_fees: 0n,
    high_water_mark: 1_000_000_000_000n,
    last_fee_time: 0n,
    version: 1n,
    updatedAt: new Date().toISOString(),
  };

  it("renders expected shares to receive based on contract floor division", () => {
    render(
      <DepositModal
        isOpen={true}
        onClose={vi.fn()}
        poolSnapshot={baseSnapshot}
      />
    );

    expect(screen.getByText("Expected shares to receive")).toBeInTheDocument();
    expect(screen.getByText("Floor division (favors existing pool)")).toBeInTheDocument();
    expect(screen.getByText("250.0249999 vUSDC")).toBeInTheDocument();
  });

  it("displays stale pool warning banner when snapshot is older than 2 minutes", () => {
    const onRefresh = vi.fn();
    const staleSnapshot = {
      ...baseSnapshot,
      updatedAt: new Date(Date.now() - 130_000).toISOString(),
    };

    render(
      <DepositModal
        isOpen={true}
        onClose={vi.fn()}
        poolSnapshot={staleSnapshot}
        onRefresh={onRefresh}
      />
    );

    expect(screen.getByText("Stale pool data")).toBeInTheDocument();
    expect(
      screen.getByText(/Vault data is older than 2 minutes. Share preview and fee calculations may not reflect latest on-chain state./)
    ).toBeInTheDocument();

    const refreshButton = screen.getByRole("button", { name: "Refresh pool data" });
    fireEvent.click(refreshButton);
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("rejects amount exceeding available USDC balance", () => {
    render(
      <DepositModal
        isOpen={true}
        onClose={vi.fn()}
        poolSnapshot={baseSnapshot}
      />
    );

    const input = screen.getByLabelText("Deposit amount");
    fireEvent.change(input, { target: { value: "1500" } });

    const confirmButton = screen.getByRole("button", { name: "Confirm deposit" });
    fireEvent.click(confirmButton);

    expect(screen.getByText("Amount exceeds your available USDC balance.")).toBeInTheDocument();
  });

  it("advances to confirmation view with share math breakdown", () => {
    render(
      <DepositModal
        isOpen={true}
        onClose={vi.fn()}
        poolSnapshot={baseSnapshot}
      />
    );

    const confirmButton = screen.getByRole("button", { name: "Confirm deposit" });
    fireEvent.click(confirmButton);

    expect(screen.getByText("Deposit Confirmation")).toBeInTheDocument();
    expect(screen.getByText("Expected Shares to Mint")).toBeInTheDocument();
    expect(screen.getByText("Floor division (Soroban drip-pool)")).toBeInTheDocument();
  });
});
