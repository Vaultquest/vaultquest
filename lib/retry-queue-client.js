/**
 * Authenticated action-ledger client for the vault retry queue (#121).
 *
 * Signing is never automatic — createRetryAttempt only opens a linked intent.
 */

import {
  USER_CANCELLED,
  assertStillRetryable,
  buildRetryAttemptPayload,
  canCancelAction,
  canRetryAction,
  mapLedgerActionToQueueRow,
  selectRetryQueueRows,
} from "./retry-queue-policy.js";

const DEFAULT_BASE =
  (typeof process !== "undefined" &&
    process.env &&
    (process.env.NEXT_PUBLIC_BACKEND_URL ||
      process.env.NEXT_PUBLIC_VAULTQUEST_API_BASE_URL)) ||
  "http://localhost:3001";

function newIdempotencyKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `retry-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function unwrapData(json) {
  if (json && typeof json === "object" && "data" in json) return json.data;
  return json;
}

function assertCurrentContext(isCurrentContext, operation = "retry") {
  if (typeof isCurrentContext === "function" && !isCurrentContext()) {
    const err = new Error(`${operation}_blocked:wallet_context_changed`);
    err.code = "wallet_context_changed";
    throw err;
  }
}

/**
 * @param {object} [options]
 * @param {string} [options.baseUrl]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => Record<string, string> | Promise<Record<string, string>>} [options.getAuthHeaders]
 */
export function createRetryQueueClient(options = {}) {
  const baseUrl = (options.baseUrl || DEFAULT_BASE).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl || globalThis.fetch.bind(globalThis);
  const getAuthHeaders = options.getAuthHeaders || (async () => ({}));

  async function request(path, init = {}, isCurrentContext, operation) {
    const auth = (await getAuthHeaders()) || {};
    assertCurrentContext(isCurrentContext, operation);
    const headers = {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...auth,
      ...(init.headers || {}),
    };
    const res = await fetchImpl(`${baseUrl}${path}`, { ...init, headers });
    let body = null;
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
    }
    if (!res.ok) {
      const err = new Error(
        body?.error?.message || body?.message || `ledger_http_${res.status}`
      );
      err.status = res.status;
      err.code = body?.error?.code || body?.code || `HTTP_${res.status}`;
      err.body = body;
      throw err;
    }
    return body;
  }

  const api = {
    baseUrl,

    async listQueueActions(walletAddress, { status, limit = 50 } = {}) {
      if (!walletAddress) return [];
      const params = new URLSearchParams({
        wallet: walletAddress,
        limit: String(limit),
      });
      if (status) params.set("status", status);
      const actions = [];
      const seenCursors = new Set();
      // Bound one load without presenting a partial ledger as the full queue.
      for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
        const json = await request(`/actions?${params.toString()}`);
        const data = unwrapData(json);
        const items = Array.isArray(data)
          ? data
          : data?.items ?? data?.actions;
        if (!Array.isArray(items)) {
          throw new Error("Could not load retry queue: invalid ledger page.");
        }
        actions.push(...items);

        const pagination = json?.meta?.pagination;
        // Older one-page providers do not advertise pagination. Once a
        // cursor is followed, every response must describe its continuation.
        if (pagination === undefined && pageIndex === 0) {
          return selectRetryQueueRows(actions, { walletAddress });
        }
        if (
          !pagination ||
          typeof pagination.has_more !== "boolean" ||
          (pagination.has_more
            ? typeof pagination.next_cursor !== "string" ||
              pagination.next_cursor.trim().length === 0
            : pagination.next_cursor !== null)
        ) {
          throw new Error("Could not load retry queue: invalid pagination.");
        }
        if (!pagination.has_more) {
          return selectRetryQueueRows(actions, { walletAddress });
        }
        if (seenCursors.has(pagination.next_cursor)) {
          throw new Error("Could not load retry queue: repeated ledger cursor.");
        }
        seenCursors.add(pagination.next_cursor);
        params.set("cursor", pagination.next_cursor);
      }
      throw new Error("Could not load the complete retry queue: page limit reached.");
    },

    async getAction(actionId) {
      const json = await request(`/actions/${encodeURIComponent(actionId)}`);
      return mapLedgerActionToQueueRow(unwrapData(json));
    },

    async createRetryAttempt(originalRow, ctx = {}) {
      const walletAddress = ctx.walletAddress || originalRow.walletAddress;
      if (!walletAddress) {
        const err = new Error("wallet_required");
        err.code = "wallet_required";
        throw err;
      }

      // A displayed row is not a fresh ledger read. Reuse only an explicitly
      // supplied preflight; otherwise read the parent before any write/signing.
      const fresh = Object.prototype.hasOwnProperty.call(ctx, "freshAction")
        ? ctx.freshAction
        : await api.getAction(originalRow.id);
      if (!fresh || fresh.id !== originalRow.id) {
        const err = new Error("retry_blocked:invalid_parent_action");
        err.code = "invalid_parent_action";
        throw err;
      }
      if (!fresh.walletAddress || fresh.walletAddress !== walletAddress) {
        const err = new Error("retry_blocked:wallet_mismatch");
        err.code = "wallet_mismatch";
        throw err;
      }
      assertStillRetryable(fresh, {
        activeWalletAddress: walletAddress,
        inFlightIds: ctx.inFlightIds,
      });

      const decision = canRetryAction(fresh, {
        activeWalletAddress: walletAddress,
        inFlightIds: ctx.inFlightIds,
      });
      if (!decision.ok) {
        const err = new Error(`retry_blocked:${decision.reason}`);
        err.code = decision.reason;
        throw err;
      }

      const attempt = buildRetryAttemptPayload(fresh, {
        idempotencyKey: ctx.idempotencyKey || newIdempotencyKey(),
      });

      const json = await request(
        "/actions",
        {
          method: "POST",
          headers: { "Idempotency-Key": attempt.idempotencyKey },
          body: JSON.stringify({
            wallet_address: walletAddress,
            action_type: attempt.actionType,
            action_payload: attempt.actionPayload,
          }),
        },
        ctx.isCurrentContext,
      );

      const created = mapLedgerActionToQueueRow(unwrapData(json));

      let signature = null;
      if (typeof ctx.requestSign === "function") {
        assertCurrentContext(ctx.isCurrentContext);
        signature = await ctx.requestSign(created);
      }

      return { action: created, signature, parentActionId: originalRow.id };
    },

    async cancelAction(row, ctx = {}) {
      assertCurrentContext(ctx.isCurrentContext, "cancel");
      const walletAddress = ctx.walletAddress || row.walletAddress;
      let fresh = ctx.freshAction;
      if (!fresh) {
        try {
          fresh = await api.getAction(row.id);
        } catch {
          fresh = row;
        }
      }

      assertCurrentContext(ctx.isCurrentContext, "cancel");
      const decision = canCancelAction(fresh, {
        activeWalletAddress: walletAddress,
        inFlightIds: ctx.inFlightIds,
      });

      if (!decision.ok) {
        const err = new Error(`cancel_blocked:${decision.reason}`);
        err.code = decision.reason;
        err.details = decision;
        throw err;
      }

      if (decision.idempotent) {
        return { action: fresh, idempotent: true };
      }

      const json = await request(
        `/actions/${encodeURIComponent(row.id)}/cancel`,
        {
          method: "POST",
          body: JSON.stringify({
            error_code: ctx.errorCode || USER_CANCELLED,
            error_detail: ctx.errorDetail || "Action was cancelled by user",
          }),
        },
        ctx.isCurrentContext,
        "cancel",
      );

      return {
        action: mapLedgerActionToQueueRow(unwrapData(json)),
        idempotent: false,
      };
    },
  };

  return api;
}

export default createRetryQueueClient;
