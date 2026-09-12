/**
 * Withdrawal queue for delayed strategy liquidity (#174).
 *
 * A withdrawal is not always instant: a strategy can hold liquidity that needs
 * to be returned first. Today there is no vocabulary for that wait, so a user
 * who requests a withdrawal and does not receive it immediately has no way to
 * tell "queued behind others" apart from "stuck" or "failed", and no way to
 * cancel a request that has not been served yet.
 *
 * This module is the vocabulary: six states, the transitions between them, the
 * cancellation rule, and a FIFO projection over available liquidity. It is pure
 * and holds no network or React state, so the rules are testable directly and
 * the UI can render whatever it is handed.
 *
 * Cancellation rule: a request can be cancelled while it is requested, queued
 * or ready, and never once it is fulfilled. A cancelled request is terminal -
 * there is no "un-cancel", because the funds may already be moving.
 */

export type WithdrawalState =
  | "requested"
  | "queued"
  | "ready"
  | "fulfilled"
  | "failed"
  | "cancelled";

export type WithdrawalEvent =
  | { type: "queue" }
  | { type: "liquidity_available" }
  | { type: "fulfill"; txHash: string }
  | { type: "fail"; reason: string }
  | { type: "cancel" };

export interface WithdrawalRequest {
  id: string;
  /** Wallet that owns the request; stored lowercased for comparisons. */
  address: string;
  /** Decimal string, never a float. */
  amount: string;
  asset: string;
  /** ISO timestamp the user asked for the withdrawal. */
  requestedAt: string;
  state: WithdrawalState;
  /** Set when liquidity was available and the request became servable. */
  readyAt?: string | null;
  /** On-chain reference once fulfilled. */
  txHash?: string | null;
  /** Why it failed, when it did. */
  failureReason?: string | null;
}

export type WithdrawalTransition =
  | { ok: true; state: WithdrawalState; patch: Partial<WithdrawalRequest> }
  | { ok: false; reason: "already_terminal" | "invalid_transition"; message: string };

export const TERMINAL_WITHDRAWAL_STATES: readonly WithdrawalState[] = [
  "fulfilled",
  "failed",
  "cancelled",
];

const STROOP_DECIMALS = 7;

export function isTerminalWithdrawal(state: WithdrawalState): boolean {
  return TERMINAL_WITHDRAWAL_STATES.includes(state);
}

/** A request can be cancelled until it is served. */
export function canCancelWithdrawal(state: WithdrawalState): boolean {
  return state === "requested" || state === "queued" || state === "ready";
}

/**
 * Apply one event. Illegal combinations are rejected with a reason instead of
 * being silently accepted, so a late callback cannot resurrect a cancelled
 * request or double-fulfil one.
 */
export function nextWithdrawalState(
  current: WithdrawalState,
  event: WithdrawalEvent,
): WithdrawalTransition {
  if (isTerminalWithdrawal(current)) {
    return {
      ok: false,
      reason: "already_terminal",
      message:
        "A withdrawal that is " + current + " is final and cannot change again.",
    };
  }

  switch (event.type) {
    case "queue":
      if (current !== "requested") {
        return invalid(current, event.type, "requested");
      }
      return { ok: true, state: "queued", patch: {} };

    case "liquidity_available":
      if (current !== "queued" && current !== "requested") {
        return invalid(current, event.type, "requested or queued");
      }
      return { ok: true, state: "ready", patch: {} };

    case "fulfill":
      if (current !== "ready" && current !== "queued") {
        return invalid(current, event.type, "queued or ready");
      }
      return {
        ok: true,
        state: "fulfilled",
        patch: { txHash: event.txHash, failureReason: null },
      };

    case "fail":
      return {
        ok: true,
        state: "failed",
        patch: { failureReason: event.reason },
      };

    case "cancel":
      if (!canCancelWithdrawal(current)) {
        return invalid(current, event.type, "requested, queued or ready");
      }
      return { ok: true, state: "cancelled", patch: {} };

    default:
      return invalid(current, String((event as { type?: string }).type), "a known event");
  }
}

function invalid(
  current: WithdrawalState,
  event: string,
  expected: string,
): WithdrawalTransition {
  return {
    ok: false,
    reason: "invalid_transition",
    message:
      "Cannot apply " + event + " to a withdrawal that is " + current + "; expected " + expected + ".",
  };
}

export interface WithdrawalStatus {
  label: string;
  tone: "progress" | "waiting" | "success" | "danger" | "neutral";
  detail: string;
  /** Whether the user has something useful to do about it. */
  actionable: boolean;
}

/** User-facing status for one request. */
export function describeWithdrawalState(
  request: Pick<WithdrawalRequest, "state" | "failureReason" | "txHash"> & {
    position?: number | null;
  },
): WithdrawalStatus {
  switch (request.state) {
    case "requested":
      return {
        label: "Requested",
        tone: "progress",
        detail: "Your withdrawal request is being recorded.",
        actionable: false,
      };
    case "queued":
      return {
        label: "Queued",
        tone: "waiting",
        detail:
          request.position && request.position > 1
            ? "Waiting on liquidity from the strategy. You are position " +
              request.position +
              " in the queue."
            : "Waiting on liquidity from the strategy.",
        actionable: true,
      };
    case "ready":
      return {
        label: "Ready to withdraw",
        tone: "progress",
        detail: "Liquidity is available. Complete the withdrawal to move your funds.",
        actionable: true,
      };
    case "fulfilled":
      return {
        label: "Withdrawn",
        tone: "success",
        detail: request.txHash
          ? "Funds sent on-chain. Transaction " + request.txHash + "."
          : "Funds sent on-chain.",
        actionable: false,
      };
    case "failed":
      return {
        label: "Failed",
        tone: "danger",
        detail: request.failureReason
          ? "The withdrawal failed: " + request.failureReason
          : "The withdrawal failed and no funds moved.",
        actionable: true,
      };
    case "cancelled":
      return {
        label: "Cancelled",
        tone: "neutral",
        detail: "You cancelled this request. Nothing moved on-chain.",
        actionable: false,
      };
    default:
      return {
        label: "Unknown",
        tone: "neutral",
        detail: "This withdrawal is in a state this build does not recognise.",
        actionable: false,
      };
  }
}

function toStroops(amount: string): bigint {
  const parts = String(amount).split(".");
  const whole = parts[0];
  const fraction = parts.length > 1 ? parts[1] : "";
  const padded = fraction.padEnd(STROOP_DECIMALS, "0").slice(0, STROOP_DECIMALS);
  return BigInt(whole || "0") * 10n ** BigInt(STROOP_DECIMALS) + BigInt(padded === "" ? "0" : padded);
}

/** FIFO: earliest request first, ties broken by id so the order is stable. */
export function orderQueue(requests: WithdrawalRequest[]): WithdrawalRequest[] {
  return [...requests]
    .filter((request) => !isTerminalWithdrawal(request.state))
    .sort((a, b) => {
      const at = Date.parse(a.requestedAt);
      const bt = Date.parse(b.requestedAt);
      if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

/** 1-based position among open requests, or null when the id is not open. */
export function queuePosition(requests: WithdrawalRequest[], id: string): number | null {
  const index = orderQueue(requests).findIndex((request) => request.id === id);
  return index === -1 ? null : index + 1;
}

/**
 * Which open requests can be served with the liquidity available now, walking
 * the queue in order. A request that does not fit does not block later smaller
 * ones from being reported as waiting - it simply consumes what it can, and
 * everything unfunded stays waiting.
 */
export function projectLiquidity(
  requests: WithdrawalRequest[],
  availableLiquidity: string,
): { ready: string[]; waiting: string[] } {
  let remaining = toStroops(availableLiquidity);
  const ready: string[] = [];
  const waiting: string[] = [];

  for (const request of orderQueue(requests)) {
    const cost = toStroops(request.amount);
    if (cost <= remaining) {
      remaining -= cost;
      ready.push(request.id);
    } else {
      waiting.push(request.id);
    }
  }

  return { ready, waiting };
}
