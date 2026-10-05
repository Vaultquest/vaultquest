/**
 * Retry-queue policy for ledger-backed vault actions (#121).
 *
 * Every queue row must map to an authoritative action-ledger record.
 * Retries are gated by error-code policy; confirmed / non-retryable
 * actions cannot be replayed. Cancellation is modeled as a stateful,
 * idempotent transition — never a local-only UI timer.
 */

/** Ledger statuses that may appear in the retry queue. */
export const QUEUEABLE_STATUSES = Object.freeze(["pending", "failed"]);

/** Terminal statuses that must never be retried. */
export const NON_REPLAYABLE_STATUSES = Object.freeze([
  "confirmed",
  "reverted",
  "orphaned",
  "submitted",
]);

/**
 * Error codes that are safe to retry with a fresh signed attempt.
 * Codes not listed here (or null) are treated as non-retryable.
 */
export const RETRYABLE_ERROR_CODES = Object.freeze({
  WALLET_REJECTED: {
    retryable: true,
    label: "Wallet rejected the signature request",
    userMessage: "Transaction was rejected in your wallet. Click retry to try again.",
  },
  WALLET_TIMEOUT: {
    retryable: true,
    label: "Wallet signature timed out",
    userMessage: "The wallet did not respond in time. Please retry.",
  },
  NETWORK_ERROR: {
    retryable: true,
    label: "Network / RPC failure",
    userMessage: "A network error occurred. Check your connection and retry.",
  },
  RPC_TIMEOUT: {
    retryable: true,
    label: "RPC timeout",
    userMessage: "The RPC request timed out. Please retry.",
  },
  TIMEOUT: {
    retryable: true,
    label: "Generic timeout",
    userMessage: "The transaction timed out. Please retry.",
  },
  INSUFFICIENT_FEES: {
    retryable: true,
    label: "Insufficient fee balance",
    userMessage: "Not enough XLM for transaction fees. Fund your wallet and retry.",
  },
});

/** Codes that mark an intentional user cancel (idempotent cancel target). */
export const CANCEL_ERROR_CODES = Object.freeze([
  "USER_CANCELLED",
  "CANCELLED_BY_USER",
]);

export const USER_CANCELLED = "USER_CANCELLED";

/**
 * Normalize a ledger action (snake_case API or camelCase) into a queue row.
 * Returns null when the record cannot be shown in the queue.
 */
export function mapLedgerActionToQueueRow(action) {
  if (!action || typeof action !== "object") return null;
  const id = action.id ?? action.action_id;
  if (!id) return null;

  const status = action.status;
  const errorCode = action.error_code ?? action.errorCode ?? null;
  const errorDetail = action.error_detail ?? action.errorDetail ?? null;
  const payload = action.action_payload ?? action.actionPayload ?? {};
  const actionType = action.action_type ?? action.actionType ?? "deposit";
  const retryCount = Number(action.retry_count ?? action.retryCount ?? 0) || 0;
  const createdAt = action.created_at ?? action.createdAt ?? null;
  const walletAddress = action.wallet_address ?? action.walletAddress ?? null;
  const parentActionId =
    payload?.parent_action_id ??
    payload?.parentActionId ??
    payload?.retry_of ??
    null;

  const pool =
    payload?.pool_name ??
    payload?.poolName ??
    payload?.vault_name ??
    payload?.vaultName ??
    payload?.vault_id ??
    payload?.vaultId ??
    "Vault";

  const amount =
    payload?.amount ??
    payload?.amount_minor ??
    payload?.amountMinor ??
    "";

  const token = payload?.token ?? payload?.asset_code ?? payload?.assetCode ?? "USDC";

  return {
    id: String(id),
    type: actionType,
    pool: String(pool),
    amount: String(amount),
    token: String(token),
    status,
    errorCode,
    errorDetail,
    createdAt,
    retryCount,
    walletAddress,
    parentActionId: parentActionId ? String(parentActionId) : null,
    payload,
    /** Authoritative ledger snapshot — never invent fields client-side. */
    ledger: action,
  };
}

/** True when this error code is allowed to spawn a fresh signed attempt. */
export function isRetryableErrorCode(errorCode) {
  if (!errorCode) return false;
  return Boolean(RETRYABLE_ERROR_CODES[errorCode]?.retryable);
}

export function getErrorUserMessage(errorCode, errorDetail) {
  const entry = errorCode ? RETRYABLE_ERROR_CODES[errorCode] : null;
  return entry?.userMessage || errorDetail || "An unknown error occurred.";
}

/**
 * Can this authoritative record be replayed?
 * Rejects confirmed / submitted / reverted / orphaned and non-retryable codes.
 */
export function canRetryAction(action, options = {}) {
  const row = action?.ledger ? action : mapLedgerActionToQueueRow(action);
  if (!row) {
    return { ok: false, reason: "missing_action" };
  }

  const activeWallet = options.activeWalletAddress ?? options.walletAddress ?? null;
  if (activeWallet && row.walletAddress && activeWallet !== row.walletAddress) {
    return { ok: false, reason: "wallet_mismatch" };
  }

  if (NON_REPLAYABLE_STATUSES.includes(row.status)) {
    return { ok: false, reason: "not_replayable_status", status: row.status };
  }

  if (row.status === "confirmed") {
    return { ok: false, reason: "already_confirmed" };
  }

  if (row.status === "pending") {
    // Pending rows are cancelable, not retryable (would duplicate in-flight work).
    return { ok: false, reason: "still_pending" };
  }

  if (row.status !== "failed") {
    return { ok: false, reason: "unsupported_status", status: row.status };
  }

  if (CANCEL_ERROR_CODES.includes(row.errorCode)) {
    return { ok: false, reason: "cancelled" };
  }

  if (!isRetryableErrorCode(row.errorCode)) {
    return { ok: false, reason: "non_retryable_error", errorCode: row.errorCode };
  }

  if (options.inFlightIds?.has?.(row.id)) {
    return { ok: false, reason: "duplicate_click" };
  }

  return { ok: true };
}

/**
 * Cancel decision against an authoritative record.
 * Idempotent when already cancelled / failed with a cancel code.
 */
export function canCancelAction(action, options = {}) {
  const row = action?.ledger ? action : mapLedgerActionToQueueRow(action);
  if (!row) {
    return { ok: false, reason: "missing_action" };
  }

  const activeWallet = options.activeWalletAddress ?? options.walletAddress ?? null;
  if (activeWallet && row.walletAddress && activeWallet !== row.walletAddress) {
    return { ok: false, reason: "wallet_mismatch" };
  }

  // Idempotent success: already cancelled on the ledger.
  if (CANCEL_ERROR_CODES.includes(row.errorCode)) {
    return { ok: true, idempotent: true, reason: "already_cancelled" };
  }

  if (NON_REPLAYABLE_STATUSES.includes(row.status) || row.status === "confirmed") {
    return { ok: false, reason: "not_cancellable_status", status: row.status };
  }

  if (row.status === "failed") {
    // Failed (non-cancel) rows are dismissed locally; cancel endpoint is for pending.
    return { ok: false, reason: "already_failed", dismissLocally: true };
  }

  if (row.status !== "pending") {
    return { ok: false, reason: "unsupported_status", status: row.status };
  }

  if (options.inFlightIds?.has?.(row.id)) {
    return { ok: false, reason: "duplicate_click" };
  }

  return { ok: true, idempotent: false };
}

/** Filter ledger list down to queueable rows for the active wallet. */
export function selectRetryQueueRows(actions, { walletAddress } = {}) {
  const list = Array.isArray(actions) ? actions : [];
  const rows = [];
  for (const action of list) {
    const row = mapLedgerActionToQueueRow(action);
    if (!row) continue;
    if (walletAddress && row.walletAddress && row.walletAddress !== walletAddress) {
      continue;
    }
    if (!QUEUEABLE_STATUSES.includes(row.status)) continue;
    // Hide cancelled rows from the active queue (they are terminal dismissals).
    if (CANCEL_ERROR_CODES.includes(row.errorCode)) continue;
    rows.push(row);
  }
  return rows;
}

/**
 * Build the payload for a fresh retry attempt linked to the original action.
 * Does not sign — callers must request a wallet signature separately.
 */
export function buildRetryAttemptPayload(originalRow, { idempotencyKey } = {}) {
  if (!originalRow?.id) {
    throw new Error("original action id is required");
  }
  const base =
    originalRow.payload && typeof originalRow.payload === "object"
      ? { ...originalRow.payload }
      : {};

  return {
    actionType: originalRow.type,
    actionPayload: {
      ...base,
      parent_action_id: originalRow.id,
      retry_of: originalRow.id,
      retry_attempt: (originalRow.retryCount || 0) + 1,
    },
    idempotencyKey: idempotencyKey || null,
    parentActionId: originalRow.id,
  };
}

/**
 * Resolve a late-confirmation race: if the authoritative record flipped to
 * confirmed between queue render and retry click, refuse replay.
 */
export function assertStillRetryable(freshAction, options = {}) {
  const decision = canRetryAction(freshAction, options);
  if (!decision.ok) {
    const err = new Error(`retry_blocked:${decision.reason}`);
    err.code = decision.reason;
    err.details = decision;
    throw err;
  }
  return decision;
}
