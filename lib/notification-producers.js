/**
 * Notification producers for #118.
 * Action / round / prize / deposit deliveries honor wallet prefs;
 * security notices always deliver.
 */

import {
  shouldDeliverNotification,
  loadNotificationPrefs,
  createDefaultRecord,
} from "./notification-prefs.js";

export const PRODUCER_CATEGORIES = Object.freeze([
  "action",
  "round",
  "prize",
  "deposit",
  "security",
]);

/**
 * Resolve prefs for a wallet from an injected loader (server store, memory, etc.).
 * @param {(wallet: string) => Promise<object|null>|object|null} loadPrefs
 * @param {string} wallet
 */
export async function resolvePrefsRecord(loadPrefs, wallet) {
  if (!wallet || !String(wallet).trim()) {
    return createDefaultRecord("");
  }
  if (!loadPrefs) {
    return createDefaultRecord(wallet);
  }
  const loaded = await loadPrefs(wallet);
  if (loaded?.prefs) return loaded;
  if (loaded?.record?.prefs) return loaded.record;
  return createDefaultRecord(wallet);
}

/**
 * Load prefs from browser-like storage (tests / client helpers).
 */
export function loadPrefsFromStorage(storage, wallet) {
  const result = loadNotificationPrefs(storage, wallet);
  if (result.ok && result.record) return result.record;
  return createDefaultRecord(wallet || "");
}

/**
 * Attempt delivery. Returns { delivered, skipped, reason, category, payload }.
 * @param {object} opts
 * @param {string} opts.wallet
 * @param {string} opts.category - action|round|prize|deposit|security
 * @param {object} opts.payload
 * @param {object|null} [opts.prefsRecord]
 * @param {(wallet: string) => Promise<object|null>|object|null} [opts.loadPrefs]
 * @param {(msg: object) => Promise<void>|void} [opts.send] - existing delivery channel; required to claim delivery
 */
export async function produceNotification(opts) {
  const { wallet, category, payload, prefsRecord, loadPrefs, send } = opts || {};
  if (!PRODUCER_CATEGORIES.includes(category)) {
    return { delivered: false, skipped: true, reason: "unknown-category", category, payload };
  }
  const record = category === "security" ? createDefaultRecord(wallet || "") :
    prefsRecord ||
    (await resolvePrefsRecord(loadPrefs, wallet)) ||
    createDefaultRecord(wallet || "");

  if (!shouldDeliverNotification(record, category)) {
    return {
      delivered: false,
      skipped: true,
      reason: "pref-opt-out",
      category,
      wallet,
      payload,
    };
  }

  const message = {
    wallet,
    category,
    payload,
    prefsVersion: record.version ?? 1,
    at: Date.now(),
  };

  if (typeof send !== "function") {
    return { delivered: false, skipped: true, reason: "no-sender", category, wallet, payload };
  }
  await send(message);

  return { delivered: true, skipped: false, reason: "ok", category, wallet, payload: message };
}

export function produceActionNotification(opts) {
  return produceNotification({ ...opts, category: "action" });
}
export function produceRoundNotification(opts) {
  return produceNotification({ ...opts, category: "round" });
}
export function producePrizeNotification(opts) {
  return produceNotification({ ...opts, category: "prize" });
}
export function produceDepositNotification(opts) {
  return produceNotification({ ...opts, category: "deposit" });
}
export function produceSecurityNotification(opts) {
  return produceNotification({ ...opts, category: "security" });
}
