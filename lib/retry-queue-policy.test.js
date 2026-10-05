import { describe, it, expect } from "vitest";
import {
  assertStillRetryable,
  buildRetryAttemptPayload,
  canCancelAction,
  canRetryAction,
  isRetryableErrorCode,
  mapLedgerActionToQueueRow,
  selectRetryQueueRows,
  USER_CANCELLED,
} from "./retry-queue-policy.js";

const WALLET_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const WALLET_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF";

function makeLedgerAction(overrides = {}) {
  return {
    id: "act-001",
    wallet_address: WALLET_A,
    action_type: "deposit",
    action_payload: {
      vault_id: "vault-usdc",
      pool_name: "USDC Yield Pool",
      amount: "500",
      token: "USDC",
    },
    status: "failed",
    error_code: "WALLET_REJECTED",
    error_detail: "User rejected the transaction in wallet",
    retry_count: 0,
    created_at: new Date("2026-09-24T12:00:00Z").toISOString(),
    ...overrides,
  };
}

describe("mapLedgerActionToQueueRow", () => {
  it("maps every queue row to an authoritative ledger record", () => {
    const ledger = makeLedgerAction();
    const row = mapLedgerActionToQueueRow(ledger);
    expect(row.id).toBe("act-001");
    expect(row.ledger).toBe(ledger);
    expect(row.walletAddress).toBe(WALLET_A);
    expect(row.errorCode).toBe("WALLET_REJECTED");
    expect(row.pool).toContain("USDC");
  });
});

describe("error-code retry policy", () => {
  it("allows wallet rejection retries", () => {
    expect(isRetryableErrorCode("WALLET_REJECTED")).toBe(true);
    expect(canRetryAction(makeLedgerAction()).ok).toBe(true);
  });

  it("allows RPC timeout retries", () => {
    expect(
      canRetryAction(makeLedgerAction({ error_code: "RPC_TIMEOUT" })).ok
    ).toBe(true);
  });

  it("allows insufficient fee retries", () => {
    expect(
      canRetryAction(makeLedgerAction({ error_code: "INSUFFICIENT_FEES" })).ok
    ).toBe(true);
  });

  it("blocks non-retryable and already-confirmed actions from replay", () => {
    expect(
      canRetryAction(makeLedgerAction({ error_code: "CONTRACT_ERROR" })).ok
    ).toBe(false);
    expect(
      canRetryAction(
        makeLedgerAction({ status: "confirmed", error_code: null })
      ).ok
    ).toBe(false);
    expect(
      canRetryAction(
        makeLedgerAction({ status: "submitted", error_code: null })
      ).ok
    ).toBe(false);
  });
});

describe("duplicate click", () => {
  it("rejects a second in-flight retry for the same action id", () => {
    const row = mapLedgerActionToQueueRow(makeLedgerAction());
    const decision = canRetryAction(row, { inFlightIds: new Set([row.id]) });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("duplicate_click");
  });
});

describe("late confirmation", () => {
  it("throws when the authoritative record flipped to confirmed", () => {
    const confirmed = mapLedgerActionToQueueRow(
      makeLedgerAction({ status: "confirmed", error_code: null })
    );
    expect(() => assertStillRetryable(confirmed)).toThrow(/retry_blocked/);
    try {
      assertStillRetryable(confirmed);
    } catch (err) {
      expect(["already_confirmed", "not_replayable_status"]).toContain(err.code);
    }
  });
});

describe("cancellation", () => {
  it("allows cancelling a pending action", () => {
    const row = mapLedgerActionToQueueRow(
      makeLedgerAction({ status: "pending", error_code: null })
    );
    expect(canCancelAction(row)).toMatchObject({ ok: true, idempotent: false });
  });

  it("is idempotent when already cancelled", () => {
    const row = mapLedgerActionToQueueRow(
      makeLedgerAction({ status: "failed", error_code: USER_CANCELLED })
    );
    const decision = canCancelAction(row);
    expect(decision.ok).toBe(true);
    expect(decision.idempotent).toBe(true);
  });

  it("rejects cancel of confirmed actions", () => {
    const row = mapLedgerActionToQueueRow(
      makeLedgerAction({ status: "confirmed", error_code: null })
    );
    expect(canCancelAction(row).ok).toBe(false);
  });
});

describe("wallet switching", () => {
  it("blocks retry/cancel when the active wallet does not own the row", () => {
    const row = mapLedgerActionToQueueRow(makeLedgerAction());
    expect(canRetryAction(row, { activeWalletAddress: WALLET_B }).reason).toBe(
      "wallet_mismatch"
    );
    expect(
      canCancelAction(
        mapLedgerActionToQueueRow(
          makeLedgerAction({ status: "pending", error_code: null })
        ),
        { activeWalletAddress: WALLET_B }
      ).reason
    ).toBe("wallet_mismatch");
  });

  it("filters queue rows to the active wallet only", () => {
    const rows = selectRetryQueueRows(
      [
        makeLedgerAction({ id: "a1", wallet_address: WALLET_A }),
        makeLedgerAction({ id: "a2", wallet_address: WALLET_B }),
      ],
      { walletAddress: WALLET_A }
    );
    expect(rows.map((r) => r.id)).toEqual(["a1"]);
  });
});

describe("buildRetryAttemptPayload", () => {
  it("creates a fresh attempt linked to the original action", () => {
    const row = mapLedgerActionToQueueRow(makeLedgerAction());
    const attempt = buildRetryAttemptPayload(row, {
      idempotencyKey: "11111111-1111-1111-1111-111111111111",
    });
    expect(attempt.parentActionId).toBe(row.id);
    expect(attempt.actionPayload.parent_action_id).toBe(row.id);
    expect(attempt.actionPayload.retry_of).toBe(row.id);
    expect(attempt.idempotencyKey).toBe(
      "11111111-1111-1111-1111-111111111111"
    );
  });
});
