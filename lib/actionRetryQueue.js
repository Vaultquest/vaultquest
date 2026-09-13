/**
 * Action Retry Queue & Ledger Reconciliation Policy (#121).
 *
 * Provides authoritative ledger mapping, error-code retry policy, late-confirmation
 * verification, and idempotent cancellation for VaultQuest transaction actions.
 */

export const STORAGE_VERSION = 1;
export const QUEUE_STORAGE_PREFIX = "vq_retry_queue:v1:";

export const RETRYABLE_ERROR_CODES = new Set([
  "WALLET_REJECTED",
  "NETWORK_ERROR",
  "TIMEOUT",
  "RPC_TIMEOUT",
  "RPC_FAILURE",
  "INSUFFICIENT_FEES",
  "INSUFFICIENT_FEE",
  "FEE_TOO_LOW",
  "TX_FAILED",
  "RATE_LIMITED",
  "CONGESTION",
]);

export const NON_RETRYABLE_ERROR_CODES = new Set([
  "CONTRACT_INTERFACE_ERROR",
  "INVALID_PAYLOAD",
  "ILLEGAL_TRANSITION",
  "UNSUPPORTED_ACTION",
  "SIMULATION_FAILED",
  "ALREADY_EXISTS",
  "USER_CANCELLED",
]);

export const ERROR_MESSAGES = {
  WALLET_REJECTED: "Transaction was rejected in your wallet. Click retry to try again.",
  NETWORK_ERROR: "A network error occurred. Check your connection and retry.",
  TIMEOUT: "The transaction timed out. Please retry.",
  RPC_TIMEOUT: "RPC node timed out waiting for finality. Please retry.",
  RPC_FAILURE: "RPC service error during submission. Check node status and retry.",
  INSUFFICIENT_FEES: "Not enough XLM for transaction fees. Fund your wallet and retry.",
  INSUFFICIENT_FEE: "Fee is too low for current network traffic. Fund wallet and retry.",
  FEE_TOO_LOW: "Network surge detected. Retry to bump transaction fee.",
  TX_FAILED: "Transaction failed to execute. Click retry to submit again.",
  CONTRACT_INTERFACE_ERROR: "Contract invocation failed. This action cannot be replayed.",
  INVALID_PAYLOAD: "Invalid transaction payload. This action cannot be replayed.",
  USER_CANCELLED: "Action was cancelled by user.",
};

/**
 * Returns human-readable error description based on error code or fallback detail.
 * @param {string | null | undefined} errorCode
 * @param {string | null | undefined} errorDetail
 * @returns {string}
 */
export function getActionErrorMessage(errorCode, errorDetail) {
  if (errorCode && ERROR_MESSAGES[errorCode]) {
    return ERROR_MESSAGES[errorCode];
  }
  return errorDetail || "An unknown error occurred during execution.";
}

/**
 * Checks whether an action can be safely retried.
 * - Confirmed, reverted, or cancelled actions CANNOT be replayed.
 * - Non-retryable contract/payload errors CANNOT be replayed.
 * - Failed actions with retryable errors or pending actions CAN be retried.
 * @param {object} action
 * @returns {boolean}
 */
export function isActionRetryable(action) {
  if (!action) return false;

  // Terminal success, revert, or cancellation must never be replayed
  if (
    action.status === "confirmed" ||
    action.status === "reverted" ||
    action.status === "cancelled"
  ) {
    return false;
  }

  // Pending actions can be retried/rebroadcast
  if (action.status === "pending") {
    return true;
  }

  // Failed actions must match the error-code policy
  if (action.status === "failed") {
    if (!action.errorCode) return true;
    if (NON_RETRYABLE_ERROR_CODES.has(action.errorCode)) return false;
    return RETRYABLE_ERROR_CODES.has(action.errorCode);
  }

  return false;
}

/**
 * Checks if a status is terminal.
 * @param {string} status
 * @returns {boolean}
 */
export function isTerminalActionStatus(status) {
  return ["confirmed", "reverted", "cancelled", "orphaned"].includes(status);
}

/**
 * Derives local storage key for a wallet's in-flight action queue.
 * @param {string} walletAddress
 * @returns {string | null}
 */
export function getQueueStorageKey(walletAddress) {
  if (!walletAddress || typeof walletAddress !== "string") return null;
  return `${QUEUE_STORAGE_PREFIX}${walletAddress.trim().toLowerCase()}`;
}

/**
 * Reads local cached queue actions for a specific wallet.
 * @param {string} walletAddress
 * @returns {Array<object>}
 */
export function getLocalQueueActions(walletAddress) {
  if (!walletAddress || typeof window === "undefined") return [];
  const key = getQueueStorageKey(walletAddress);
  if (!key) return [];

  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Persists local queue actions for a wallet.
 * @param {string} walletAddress
 * @param {Array<object>} actions
 */
export function saveLocalQueueActions(walletAddress, actions) {
  if (!walletAddress || typeof window === "undefined") return;
  const key = getQueueStorageKey(walletAddress);
  if (!key) return;

  try {
    localStorage.setItem(key, JSON.stringify(actions));
  } catch (err) {
    console.warn("Failed to persist local action queue", err);
  }
}

/**
 * Normalizes backend ledger action into standard UI action view.
 * @param {object} raw
 * @returns {object}
 */
export function normalizeLedgerAction(raw) {
  if (!raw) return null;
  const payload = raw.action_payload || raw.actionPayload || {};
  return {
    id: raw.id,
    idempotencyKey: raw.idempotency_key || raw.idempotencyKey || raw.id,
    walletAddress: raw.wallet_address || raw.walletAddress,
    type: raw.action_type || raw.actionType || "action",
    pool: payload.pool_name || payload.poolName || payload.pool_id || payload.poolId || "Vault Pool",
    poolId: payload.pool_id || payload.poolId || null,
    amount: payload.amount != null ? String(payload.amount) : "0",
    status: raw.status || "pending",
    txHash: raw.tx_hash || raw.txHash || null,
    errorCode: raw.error_code || raw.errorCode || null,
    errorDetail: raw.error_detail || raw.errorDetail || null,
    retryCount: raw.retry_count != null ? raw.retry_count : (raw.retryCount || 0),
    createdAt: raw.created_at || raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updated_at || raw.updatedAt || new Date().toISOString(),
  };
}

export function resolveApiUrl(path, baseUrl = "") {
  if (baseUrl) return `${baseUrl}${path}`;
  if (
    typeof window !== "undefined" &&
    window.location &&
    window.location.origin &&
    window.location.origin !== "null"
  ) {
    return `${window.location.origin}${path}`;
  }
  return `http://localhost:3000${path}`;
}

/**
 * Fetches authoritative actions for a wallet from the ledger backend,
 * merging with any locally pending intents.
 * @param {string} walletAddress
 * @param {object} [options]
 * @param {string} [options.baseUrl]
 * @returns {Promise<Array<object>>}
 */
export async function fetchAuthoritativeQueueActions(walletAddress, options = {}) {
  if (!walletAddress) return [];

  const localActions = getLocalQueueActions(walletAddress);
  let remoteActions = [];

  try {
    const url = resolveApiUrl(
      `/actions?wallet=${encodeURIComponent(walletAddress)}&limit=50`,
      options.baseUrl
    );
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (res.ok) {
      const body = await res.json();
      const items = body.data || body.items || [];
      if (Array.isArray(items)) {
        remoteActions = items.map(normalizeLedgerAction).filter(Boolean);
      }
    }
  } catch {
    // Graceful offline fallback to local cached actions
  }

  // Merge authoritative remote actions with local actions
  const actionMap = new Map();

  // Populate local actions first
  for (const act of localActions) {
    if (act?.id) {
      actionMap.set(act.id, act);
    }
  }

  // Remote actions take precedence as source of truth
  for (const remote of remoteActions) {
    if (remote?.id) {
      actionMap.set(remote.id, remote);
    }
  }

  // Filter to actions relevant for the retry queue:
  // - In-flight (pending, submitted)
  // - Failed (eligible for retry or dismissal)
  const queueActions = Array.from(actionMap.values()).filter((act) => {
    return act.status === "pending" || act.status === "submitted" || act.status === "failed";
  });

  // Keep local cache synced
  saveLocalQueueActions(walletAddress, queueActions);

  return queueActions;
}

/**
 * Reconciles an action's state against the ledger to catch late confirmations.
 * @param {string} actionId
 * @param {object} [options]
 * @param {string} [options.baseUrl]
 * @returns {Promise<object | null>}
 */
export async function checkActionLateConfirmation(actionId, options = {}) {
  if (!actionId) return null;

  try {
    const url = resolveApiUrl(`/actions/${encodeURIComponent(actionId)}`, options.baseUrl);
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (res.ok) {
      const body = await res.json();
      const record = body.data || body;
      return normalizeLedgerAction(record);
    }
  } catch {
    // network failure
  }

  return null;
}

/**
 * Marks an action as cancelled statefully and idempotently.
 * @param {string} actionId
 * @param {string} walletAddress
 * @param {object} [options]
 * @param {string} [options.baseUrl]
 * @param {string} [options.reason]
 * @returns {Promise<object>}
 */
export async function cancelLedgerAction(actionId, walletAddress, options = {}) {
  if (!actionId) {
    throw new Error("Action ID is required for cancellation.");
  }

  const payload = {
    error_code: "USER_CANCELLED",
    error_detail: options.reason || "Action was cancelled by user",
  };

  let updated = null;

  try {
    const url = resolveApiUrl(
      `/actions/${encodeURIComponent(actionId)}/cancel`,
      options.baseUrl
    );
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      const body = await res.json();
      updated = normalizeLedgerAction(body.data || body);
    }
  } catch {
    // If backend unreachable, perform client-side stateful update
  }

  if (!updated) {
    updated = {
      id: actionId,
      walletAddress,
      status: "failed",
      errorCode: "USER_CANCELLED",
      errorDetail: options.reason || "Action was cancelled by user",
      updatedAt: new Date().toISOString(),
    };
  }

  // Update local storage queue
  if (walletAddress) {
    const current = getLocalQueueActions(walletAddress);
    const modified = current.filter((a) => a.id !== actionId);
    saveLocalQueueActions(walletAddress, modified);
  }

  return updated;
}
