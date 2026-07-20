import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createMockVaultClient } from "../contract/mockClient";
import { useTxFlow } from "./txStateMachine";

const INPUT = { poolId: "pool-1", walletAddress: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" };

describe("useTxFlow", () => {
  it("walks the happy path: preparing -> awaiting-signature -> submitting -> confirming -> indexing -> success", async () => {
    const client = createMockVaultClient();
    const { result } = renderHook(() => useTxFlow());

    expect(result.current.state).toEqual({ stage: "idle" });
    expect(result.current.busy).toBe(false);

    let runPromise!: Promise<void>;
    act(() => {
      runPromise = result.current.run(client, "deposit", INPUT, { indexingDelayMs: 0 });
    });

    // Transitions run synchronously up to the await on submitAction, so the
    // first observable stage past idle is awaiting-signature (mock resolves
    // submitAction on a microtask).
    await waitFor(() => expect(result.current.state.stage).not.toBe("idle"));
    expect(result.current.busy).toBe(true);

    await act(async () => {
      await runPromise;
    });

    expect(result.current.state.stage).toBe("success");
    if (result.current.state.stage === "success") {
      expect(result.current.state.txHash).toMatch(/^mocktx_deposit_/);
    }
    expect(result.current.busy).toBe(false);
  });

  it("calls onConfirmed once the tx reaches the indexing stage", async () => {
    const client = createMockVaultClient();
    const onConfirmed = vi.fn();
    const { result } = renderHook(() => useTxFlow());

    await act(async () => {
      await result.current.run(client, "join", INPUT, { indexingDelayMs: 0, onConfirmed });
    });

    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(onConfirmed).toHaveBeenCalledWith(expect.stringMatching(/^mocktx_join_/));
  });

  it("maps signature_rejected to a failed state at awaiting-signature", async () => {
    const client = createMockVaultClient({ failActions: { deposit: "signature_rejected" } });
    const { result } = renderHook(() => useTxFlow());

    await act(async () => {
      await result.current.run(client, "deposit", INPUT, { indexingDelayMs: 0 });
    });

    expect(result.current.state).toEqual({
      stage: "failed",
      failedAt: "awaiting-signature",
      message: "deposit failed: signature_rejected",
    });
    expect(result.current.busy).toBe(false);
  });

  it("maps wallet_disconnected to a failed state at awaiting-signature", async () => {
    const client = createMockVaultClient({ failActions: { withdraw: "wallet_disconnected" } });
    const { result } = renderHook(() => useTxFlow());

    await act(async () => {
      await result.current.run(client, "withdraw", INPUT, { indexingDelayMs: 0 });
    });

    expect(result.current.state.stage).toBe("failed");
    if (result.current.state.stage === "failed") {
      expect(result.current.state.failedAt).toBe("awaiting-signature");
    }
  });

  it("maps rpc_failure to a failed state at submitting", async () => {
    const client = createMockVaultClient({ failActions: { deposit: "rpc_failure" } });
    const { result } = renderHook(() => useTxFlow());

    await act(async () => {
      await result.current.run(client, "deposit", INPUT, { indexingDelayMs: 0 });
    });

    expect(result.current.state.stage).toBe("failed");
    if (result.current.state.stage === "failed") {
      expect(result.current.state.failedAt).toBe("submitting");
    }
  });

  it("maps contract_error to a failed state at submitting", async () => {
    const client = createMockVaultClient({ failActions: { claim: "contract_error" } });
    const { result } = renderHook(() => useTxFlow());

    await act(async () => {
      await result.current.run(client, "claim", INPUT, { indexingDelayMs: 0 });
    });

    expect(result.current.state.stage).toBe("failed");
    if (result.current.state.stage === "failed") {
      expect(result.current.state.failedAt).toBe("submitting");
    }
  });

  it("maps an unrecognized error kind to a failed state at confirming", async () => {
    const client = createMockVaultClient({ failActions: { deposit: "stale_data" } });
    const { result } = renderHook(() => useTxFlow());

    await act(async () => {
      await result.current.run(client, "deposit", INPUT, { indexingDelayMs: 0 });
    });

    expect(result.current.state.stage).toBe("failed");
    if (result.current.state.stage === "failed") {
      expect(result.current.state.failedAt).toBe("confirming");
    }
  });

  it("reset() returns the machine to idle after a terminal state", async () => {
    const client = createMockVaultClient({ failActions: { deposit: "rpc_failure" } });
    const { result } = renderHook(() => useTxFlow());

    await act(async () => {
      await result.current.run(client, "deposit", INPUT, { indexingDelayMs: 0 });
    });
    expect(result.current.state.stage).toBe("failed");

    act(() => {
      result.current.reset();
    });
    expect(result.current.state).toEqual({ stage: "idle" });
    expect(result.current.busy).toBe(false);
  });

  it("ignores a second run() while one is already in flight (no duplicate submission)", async () => {
    let resolveSubmit!: (v: { txHash: string; status: "submitted" }) => void;
    const client = createMockVaultClient();
    const submitSpy = vi.spyOn(client, "submitAction").mockImplementation(
      () => new Promise((resolve) => { resolveSubmit = resolve; }),
    );

    const { result } = renderHook(() => useTxFlow());

    let firstRun!: Promise<void>;
    act(() => {
      firstRun = result.current.run(client, "deposit", INPUT, { indexingDelayMs: 0 });
    });
    await waitFor(() => expect(result.current.busy).toBe(true));

    // A second run while the first is in flight must not call submitAction again.
    let secondRun!: Promise<void>;
    act(() => {
      secondRun = result.current.run(client, "deposit", INPUT, { indexingDelayMs: 0 });
    });
    await Promise.resolve();

    expect(submitSpy).toHaveBeenCalledTimes(1);

    act(() => {
      resolveSubmit({ txHash: "mocktx_deposit_1", status: "submitted" });
    });
    await act(async () => {
      await Promise.all([firstRun, secondRun]);
    });

    expect(result.current.state.stage).toBe("success");
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it("succeeds on retry after a recoverable failure without leaving stale failed state", async () => {
    const client = createMockVaultClient({ failActions: { deposit: "rpc_failure" } });
    const { result } = renderHook(() => useTxFlow());

    await act(async () => {
      await result.current.run(client, "deposit", INPUT, { indexingDelayMs: 0 });
    });
    expect(result.current.state.stage).toBe("failed");

    act(() => {
      result.current.reset();
    });

    const recoveredClient = createMockVaultClient();
    await act(async () => {
      await result.current.run(recoveredClient, "deposit", INPUT, { indexingDelayMs: 0 });
    });

    expect(result.current.state.stage).toBe("success");
  });
});
