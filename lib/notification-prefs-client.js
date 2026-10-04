import { NOTIFICATION_PREFS_VERSION, OPTIONAL_PREF_KEYS } from "./notification-prefs";

let lastChallengeTimestamp = 0;

export class NotificationRequestError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "NotificationRequestError";
    this.status = status;
  }
}

async function signWithConnectedWallet(message, options) {
  const { kit } = await import("@/stellar-wallet-connect/src/core/kit");
  if (typeof kit.signMessage !== "function") {
    throw new NotificationRequestError("This wallet does not support message signing.");
  }
  return kit.signMessage(message, options);
}

function signatureBase64(value) {
  if (typeof value !== "string") {
    throw new NotificationRequestError("The wallet did not return a message signature.");
  }
  const signature = value.trim();
  if (/^(?:0x)?[a-fA-F0-9]{128}$/.test(signature)) {
    const hex = signature.replace(/^0x/, "");
    return btoa(hex.match(/../g).map((byte) => String.fromCharCode(parseInt(byte, 16))).join(""));
  }
  try {
    const bytes = atob(signature);
    if (bytes.length === 64 && btoa(bytes) === signature) return signature;
  } catch {
    // A malformed signature must never be sent as an authenticated request.
  }
  throw new NotificationRequestError("The wallet returned an invalid message signature.");
}

function ensureCurrent(signal, isCurrent) {
  if (signal?.aborted || (isCurrent && !isCurrent())) {
    throw new DOMException("The wallet request is no longer current.", "AbortError");
  }
}

/** A fresh signed challenge is consumed once by the existing wallet API. */
export async function requestWalletNotification(path, {
  wallet,
  method = "GET",
  body,
  signal,
  isCurrent,
  fetchImpl = globalThis.fetch,
  signMessage = signWithConnectedWallet,
} = {}) {
  if (!wallet || typeof wallet !== "string") {
    throw new NotificationRequestError("Connect a wallet to continue.");
  }
  if (typeof fetchImpl !== "function") {
    throw new NotificationRequestError("Network access is unavailable. Try again when online.");
  }
  ensureCurrent(signal, isCurrent);
  // Concurrent reads and saves must not reuse a single-use challenge, even
  // when they start in the same millisecond.
  const timestamp = Math.max(Date.now(), lastChallengeTimestamp + 1);
  lastChallengeTimestamp = timestamp;
  const signed = await signMessage(`vaultquest:actions-export:${wallet}:${timestamp}`, { address: wallet });
  ensureCurrent(signal, isCurrent);
  if (signed?.error) {
    throw new NotificationRequestError(signed.error.message || "The wallet did not approve message signing.");
  }
  if (signed?.signerAddress && signed.signerAddress !== wallet) {
    throw new NotificationRequestError("The signing wallet changed. Reconnect the intended wallet and try again.");
  }
  const signature = signatureBase64(signed?.signedMessage);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    ensureCurrent(signal, isCurrent);
    const response = await fetchImpl(path, {
      method,
      headers: {
        "x-wallet-address": wallet,
        "x-wallet-signature": signature,
        "x-wallet-timestamp": String(timestamp),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
      cache: "no-store",
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new NotificationRequestError("The notification service returned an unreadable response.", response.status);
    }
    ensureCurrent(signal, isCurrent);
    if (!response.ok || payload?.ok === false || payload?.success === false || payload?.error) {
      throw new NotificationRequestError(
        payload?.error?.message || payload?.message || "The notification service could not complete the request.",
        response.status,
      );
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new NotificationRequestError("The notification service returned an invalid response.", response.status);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

function confirmedRecord(payload, wallet) {
  const record = payload?.data;
  if (!record || record.wallet !== wallet || record.version !== NOTIFICATION_PREFS_VERSION ||
      !Number.isSafeInteger(record.revision) || record.revision < 0 ||
      !Number.isFinite(record.updatedAt) || record.updatedAt < 0 ||
      !OPTIONAL_PREF_KEYS.every((key) => typeof record.prefs?.[key] === "boolean") ||
      record.prefs?.securityNotices !== true) {
    throw new NotificationRequestError("The server did not confirm valid preferences for this wallet. Reload and try again.");
  }
  return record;
}

export async function loadNotificationPreferences(wallet, options = {}) {
  return confirmedRecord(await requestWalletNotification(
    `/api/notification-prefs?wallet=${encodeURIComponent(wallet)}`,
    { ...options, wallet },
  ), wallet);
}

export async function saveNotificationPreferences(wallet, prefs, expectedRevision, options = {}) {
  return confirmedRecord(await requestWalletNotification("/api/notification-prefs", {
    ...options,
    wallet,
    method: "PUT",
    body: { wallet_address: wallet, prefs: { ...prefs, securityNotices: true }, expectedRevision },
  }), wallet);
}
