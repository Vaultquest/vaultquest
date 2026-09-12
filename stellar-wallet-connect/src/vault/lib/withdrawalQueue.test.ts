import { describe, it, expect } from "vitest";
import {
  canCancelWithdrawal,
  describeWithdrawalState,
  isTerminalWithdrawal,
  nextWithdrawalState,
  orderQueue,
  projectLiquidity,
  queuePosition,
  type WithdrawalRequest,
  type WithdrawalState,
} from "./withdrawalQueue";

// #174: the acceptance criteria are "users can track delayed withdrawals" and
// "tests cover fulfillment, cancellation, and failure", so those three paths are
// pinned here along with the rule that a terminal withdrawal never changes.

const WALLET_A = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function request(overrides: Partial<WithdrawalRequest> = {}): WithdrawalRequest {
  return {
    id: "w1",
    address: WALLET_A.toLowerCase(),
    amount: "10.0000000",
    asset: "USDC",
    requestedAt: "2026-09-13T00:00:00.000Z",
    state: "requested",
    readyAt: null,
    txHash: null,
    failureReason: null,
    ...overrides,
  };
}

describe("isTerminalWithdrawal / canCancelWithdrawal", () => {
  it("treats fulfilled, failed and cancelled as final", () => {
    expect(isTerminalWithdrawal("fulfilled")).toBe(true);
    expect(isTerminalWithdrawal("failed")).toBe(true);
    expect(isTerminalWithdrawal("cancelled")).toBe(true);
    expect(isTerminalWithdrawal("queued")).toBe(false);
  });

  it("allows cancellation until the request is served", () => {
    expect(canCancelWithdrawal("requested")).toBe(true);
    expect(canCancelWithdrawal("queued")).toBe(true);
    expect(canCancelWithdrawal("ready")).toBe(true);
    for (const state of ["fulfilled", "failed", "cancelled"] as WithdrawalState[]) {
      expect(canCancelWithdrawal(state)).toBe(false);
    }
  });
});

describe("nextWithdrawalState: the happy path", () => {
  it("moves requested -> queued -> ready -> fulfilled", () => {
    const queued = nextWithdrawalState("requested", { type: "queue" });
    expect(queued).toEqual({ ok: true, state: "queued", patch: {} });

    const ready = nextWithdrawalState("queued", { type: "liquidity_available" });
    expect(ready).toEqual({ ok: true, state: "ready", patch: {} });

    const fulfilled = nextWithdrawalState("ready", { type: "fulfill", txHash: "abc123" });
    expect(fulfilled).toEqual({
      ok: true,
      state: "fulfilled",
      patch: { txHash: "abc123", failureReason: null },
    });
  });

  it("lets liquidity arrive while the request is still being queued", () => {
    expect(nextWithdrawalState("requested", { type: "liquidity_available" })).toEqual({
      ok: true,
      state: "ready",
      patch: {},
    });
  });

  it("can fulfil straight from the queue without an explicit ready step", () => {
    const result = nextWithdrawalState("queued", { type: "fulfill", txHash: "tx9" });
    expect(result.ok && result.state).toBe("fulfilled");
  });
});

describe("nextWithdrawalState: cancellation and failure", () => {
  it("cancels while the request is still open", () => {
    for (const state of ["requested", "queued", "ready"] as WithdrawalState[]) {
      const result = nextWithdrawalState(state, { type: "cancel" });
      expect(result).toEqual({ ok: true, state: "cancelled", patch: {} });
    }
  });

  it("records the reason when a withdrawal fails", () => {
    const result = nextWithdrawalState("queued", {
      type: "fail",
      reason: "strategy liquidity returned short",
    });
    expect(result).toEqual({
      ok: true,
      state: "failed",
      patch: { failureReason: "strategy liquidity returned short" },
    });
  });

  it("refuses to cancel a fulfilled withdrawal", () => {
    const result = nextWithdrawalState("fulfilled", { type: "cancel" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("already_terminal");
  });

  it("refuses every event on a terminal state, so a late callback cannot move money twice", () => {
    for (const state of ["fulfilled", "failed", "cancelled"] as WithdrawalState[]) {
      for (const event of [
        { type: "queue" },
        { type: "liquidity_available" },
        { type: "fulfill", txHash: "x" },
        { type: "fail", reason: "r" },
        { type: "cancel" },
      ] as const) {
        const result = nextWithdrawalState(state, event);
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.reason).toBe("already_terminal");
      }
    }
  });

  it("rejects a transition that does not apply instead of guessing", () => {
    const result = nextWithdrawalState("requested", { type: "fulfill", txHash: "x" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("invalid_transition");
    expect(result.ok === false && result.message).toContain("expected queued or ready");
  });
});

describe("queue ordering and position", () => {
  it("orders open requests FIFO and drops the terminal ones", () => {
    const ordered = orderQueue([
      request({ id: "late", requestedAt: "2026-09-13T02:00:00.000Z" }),
      request({ id: "done", requestedAt: "2026-09-13T00:30:00.000Z", state: "fulfilled" }),
      request({ id: "early", requestedAt: "2026-09-13T01:00:00.000Z" }),
    ]);
    expect(ordered.map((r) => r.id)).toEqual(["early", "late"]);
  });

  it("breaks ties on identical timestamps by id so the order is stable", () => {
    const ordered = orderQueue([
      request({ id: "b" }),
      request({ id: "a" }),
    ]);
    expect(ordered.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("reports a 1-based position and null when the request is not open", () => {
    const queue = [
      request({ id: "first", requestedAt: "2026-09-13T01:00:00.000Z" }),
      request({ id: "second", requestedAt: "2026-09-13T02:00:00.000Z" }),
      request({ id: "gone", requestedAt: "2026-09-13T00:00:00.000Z", state: "cancelled" }),
    ];
    expect(queuePosition(queue, "second")).toBe(2);
    expect(queuePosition(queue, "gone")).toBeNull();
  });
});

describe("projectLiquidity", () => {
  it("serves the queue in order and stops when liquidity runs out", () => {
    const queue = [
      request({ id: "first", amount: "6.0000000", requestedAt: "2026-09-13T01:00:00.000Z" }),
      request({ id: "second", amount: "6.0000000", requestedAt: "2026-09-13T02:00:00.000Z" }),
    ];
    expect(projectLiquidity(queue, "10")).toEqual({ ready: ["first"], waiting: ["second"] });
  });

  it("serves everything when liquidity covers the queue exactly", () => {
    const queue = [
      request({ id: "a", amount: "4.0000000", requestedAt: "2026-09-13T01:00:00.000Z" }),
      request({ id: "b", amount: "6.0000000", requestedAt: "2026-09-13T02:00:00.000Z" }),
    ];
    expect(projectLiquidity(queue, "10.0000000")).toEqual({ ready: ["a", "b"], waiting: [] });
  });

  it("leaves everything waiting when liquidity is short", () => {
    const queue = [request({ id: "big", amount: "50.0000000" })];
    expect(projectLiquidity(queue, "10")).toEqual({ ready: [], waiting: ["big"] });
  });

  it("does not spend liquidity on terminal requests", () => {
    const queue = [
      request({ id: "settled", amount: "5.0000000", requestedAt: "2026-09-13T01:00:00.000Z", state: "fulfilled" }),
      request({ id: "open", amount: "5.0000000", requestedAt: "2026-09-13T02:00:00.000Z" }),
    ];
    expect(projectLiquidity(queue, "5")).toEqual({ ready: ["open"], waiting: [] });
  });
});

describe("describeWithdrawalState", () => {
  it("tells a queued user where they are", () => {
    const status = describeWithdrawalState({ state: "queued", failureReason: null, txHash: null, position: 3 });
    expect(status.label).toBe("Queued");
    expect(status.tone).toBe("waiting");
    expect(status.detail).toContain("position 3");
    expect(status.actionable).toBe(true);
  });

  it("marks a ready withdrawal as actionable", () => {
    const status = describeWithdrawalState({ state: "ready", failureReason: null, txHash: null });
    expect(status.label).toBe("Ready to withdraw");
    expect(status.actionable).toBe(true);
  });

  it("includes the transaction reference once fulfilled", () => {
    const status = describeWithdrawalState({ state: "fulfilled", failureReason: null, txHash: "deadbeef" });
    expect(status.tone).toBe("success");
    expect(status.detail).toContain("deadbeef");
    expect(status.actionable).toBe(false);
  });

  it("surfaces the failure reason", () => {
    const status = describeWithdrawalState({
      state: "failed",
      failureReason: "insufficient strategy liquidity",
      txHash: null,
    });
    expect(status.tone).toBe("danger");
    expect(status.detail).toContain("insufficient strategy liquidity");
  });

  it("does not claim to know an unrecognised state", () => {
    const status = describeWithdrawalState({
      state: "something-new" as WithdrawalState,
      failureReason: null,
      txHash: null,
    });
    expect(status.label).toBe("Unknown");
    expect(status.actionable).toBe(false);
  });
});
