import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import VaultRetryQueue from "./VaultRetryQueue";
import {
  saveLocalQueueActions,
} from "@/lib/actionRetryQueue";
import * as actionRetryQueueModule from "@/lib/actionRetryQueue";
import { connectedPublicKey } from "@vaultquest/stellar-wallet-connect/src/core/store";

const mockWagmi = vi.hoisted(() => ({
  useAccount: vi.fn(() => ({ address: undefined })),
}));

vi.mock("wagmi", () => mockWagmi);

const WALLET_A = "GA2W3B4C5D6E7F8G9H0J1K2L3M4N5P6Q7R8S9T0U1V2W3X4Y5Z6A7B8C";
const WALLET_B = "GB9Y8X7W6V5U4T3S2R1Q0P9N8M7L6K5J4H3G2F1E0D9C8B7A6Z5Y4X3W";

const sampleFailedAction = {
  id: "act-wallet-reject",
  idempotencyKey: "idem-001",
  walletAddress: WALLET_A,
  type: "deposit",
  pool: "USDC Yield Pool",
  poolId: "pool-usdc",
  amount: "500",
  status: "failed",
  errorCode: "WALLET_REJECTED",
  errorDetail: "User rejected the transaction in wallet",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  retryCount: 0,
};

const sampleTimeoutAction = {
  id: "act-rpc-timeout",
  idempotencyKey: "idem-002",
  walletAddress: WALLET_A,
  type: "withdraw",
  pool: "XLM Staking Pool",
  poolId: "pool-xlm",
  amount: "250",
  status: "failed",
  errorCode: "RPC_TIMEOUT",
  errorDetail: "RPC node timed out waiting for finality",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  retryCount: 1,
};

const sampleFeeAction = {
  id: "act-fee-low",
  idempotencyKey: "idem-003",
  walletAddress: WALLET_A,
  type: "deposit",
  pool: "USDC Yield Pool",
  poolId: "pool-usdc",
  amount: "100",
  status: "failed",
  errorCode: "INSUFFICIENT_FEES",
  errorDetail: "Not enough XLM for transaction fees",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  retryCount: 0,
};

const sampleNonRetryableAction = {
  id: "act-contract-fail",
  idempotencyKey: "idem-004",
  walletAddress: WALLET_A,
  type: "deposit",
  pool: "USDC Yield Pool",
  poolId: "pool-usdc",
  amount: "1000",
  status: "failed",
  errorCode: "CONTRACT_INTERFACE_ERROR",
  errorDetail: "Contract panic: invariant violation",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  retryCount: 0,
};

describe("VaultRetryQueue (#121)", () => {
  beforeEach(() => {
    localStorage.clear();
    window.scrollTo = vi.fn();
    connectedPublicKey.set("");
    mockWagmi.useAccount.mockReturnValue({ address: undefined });
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("does not render when queue is empty", () => {
    const { container } = render(
      <VaultRetryQueue walletAddress={WALLET_A} initialActions={[]} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("displays wallet rejection error and allows the user to retry", async () => {
    const onRetry = vi.fn().mockResolvedValue({
      status: "pending",
      errorCode: null,
      errorDetail: null,
      retryCount: 1,
    });

    render(
      <VaultRetryQueue
        walletAddress={WALLET_A}
        initialActions={[sampleFailedAction]}
        onRetryAction={onRetry}
      />
    );

    expect(screen.getByText(/Transaction was rejected in your wallet/i)).toBeInTheDocument();
    expect(screen.getByText(/500 USDC/i)).toBeInTheDocument();

    const retryBtn = screen.getByRole("button", { name: /Retry deposit/i });
    expect(retryBtn).toBeEnabled();

    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith(sampleFailedAction);
    });
  });

  it("handles RPC timeout with retryable guidance", async () => {
    render(
      <VaultRetryQueue
        walletAddress={WALLET_A}
        initialActions={[sampleTimeoutAction]}
      />
    );

    expect(
      screen.getByText(/RPC node timed out waiting for finality/i)
    ).toBeInTheDocument();
    expect(screen.getByText("Retry #1")).toBeInTheDocument();

    const retryBtn = screen.getByRole("button", { name: /Retry withdraw/i });
    expect(retryBtn).toBeEnabled();
  });

  it("surfaces insufficient fee warning and actionable prompt", () => {
    render(
      <VaultRetryQueue
        walletAddress={WALLET_A}
        initialActions={[sampleFeeAction]}
      />
    );

    expect(
      screen.getByText(/Not enough XLM for transaction fees/i)
    ).toBeInTheDocument();
  });

  it("prevents duplicate concurrent clicks during in-flight retries", async () => {
    let resolveRetry;
    const slowRetryPromise = new Promise((resolve) => {
      resolveRetry = resolve;
    });
    const onRetry = vi.fn().mockReturnValue(slowRetryPromise);

    render(
      <VaultRetryQueue
        walletAddress={WALLET_A}
        initialActions={[sampleFailedAction]}
        onRetryAction={onRetry}
      />
    );

    const retryBtn = screen.getByRole("button", { name: /Retry deposit/i });

    // First click initiates retry
    fireEvent.click(retryBtn);

    // Second rapid click while in-flight must be ignored
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    // Resolve in-flight request
    await act(async () => {
      resolveRetry({ status: "pending", retryCount: 1 });
    });
  });

  it("detects late confirmation on-chain and prevents replay", async () => {
    const onRetry = vi.fn();
    // Spy on checkActionLateConfirmation returning confirmed
    vi.spyOn(actionRetryQueueModule, "checkActionLateConfirmation").mockResolvedValue({
      id: sampleFailedAction.id,
      status: "confirmed",
      errorCode: null,
    });

    render(
      <VaultRetryQueue
        walletAddress={WALLET_A}
        initialActions={[sampleFailedAction]}
        onRetryAction={onRetry}
      />
    );

    const retryBtn = screen.getByRole("button", { name: /Retry deposit/i });
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        /was already confirmed on-chain\. Replay prevented/i
      );
    });

    // Submitter was NEVER called because replay was blocked
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("enforces non-retryable error policy: contract/payload errors cannot be replayed", () => {
    render(
      <VaultRetryQueue
        walletAddress={WALLET_A}
        initialActions={[sampleNonRetryableAction]}
      />
    );

    expect(screen.getByTestId("non-retryable-badge")).toHaveTextContent("Non-retryable");
    expect(
      screen.queryByRole("button", { name: /Retry deposit/i })
    ).not.toBeInTheDocument();
  });

  it("executes stateful and idempotent cancellation for pending actions", async () => {
    const onCancel = vi.fn().mockResolvedValue({ status: "failed", errorCode: "USER_CANCELLED" });

    const pendingAction = {
      ...sampleFailedAction,
      id: "act-pending-01",
      status: "pending",
      errorCode: null,
      errorDetail: null,
    };

    render(
      <VaultRetryQueue
        walletAddress={WALLET_A}
        initialActions={[pendingAction]}
        onCancelAction={onCancel}
      />
    );

    const cancelBtn = screen.getByRole("button", { name: /Cancel pending action/i });
    fireEvent.click(cancelBtn);

    await waitFor(() => {
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/Action was cancelled by user/i)).toBeInTheDocument();
    });
  });

  it("isolates queues and reloads actions when switching wallets", async () => {
    // Save actions for Wallet A and Wallet B in local storage
    saveLocalQueueActions(WALLET_A, [sampleFailedAction]);
    saveLocalQueueActions(WALLET_B, [sampleTimeoutAction]);

    const { rerender } = render(<VaultRetryQueue walletAddress={WALLET_A} />);

    // Wallet A's action appears
    await waitFor(() => {
      expect(screen.getByText(/500 USDC/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/250 USDC/i)).not.toBeInTheDocument();

    // Switch to Wallet B
    rerender(<VaultRetryQueue walletAddress={WALLET_B} />);

    // Wallet B's action appears, Wallet A's disappears
    await waitFor(() => {
      expect(screen.getByText(/250 USDC/i)).toBeInTheDocument();
      expect(screen.queryByText(/500 USDC/i)).not.toBeInTheDocument();
    });
  });
});
