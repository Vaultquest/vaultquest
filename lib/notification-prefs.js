/**
 * Per-wallet notification preferences (#118).
 *
 * Replaces the component-local Save flash with versioned, wallet-scoped
 * durable prefs. Storage is injected so tests do not need a browser.
 */

export const NOTIFICATION_PREFS_VERSION = 1;
export const STORAGE_PREFIX = "vq_notification_prefs:v1:";
export const LEGACY_GLOBAL_KEY = "vq_notification_prefs";

export const OPTIONAL_PREF_KEYS = Object.freeze([
  "roundUpdates",
  "actionStatus",
  "winnings",
  "deposits",
]);

/** Security notices are always delivered; UI surfaces them as non-toggleable. */
export const MANDATORY_PREF_KEYS = Object.freeze(["securityNotices"]);

export const DEFAULT_PREFS = Object.freeze({
  roundUpdates: true,
  actionStatus: true,
  winnings: true,
  deposits: false,
  securityNotices: true,
});

/**
 * Map UI / producer categories onto preference keys.
 */
export const PRODUCER_CATEGORY_MAP = Object.freeze({
  round: "roundUpdates",
  action: "actionStatus",
  prize: "winnings",
  deposit: "deposits",
  security: "securityNotices",
});

export function storageKeyForWallet(wallet) {
  if (!wallet || typeof wallet !== "string" || !wallet.trim()) {
    return null;
  }
  return `${STORAGE_PREFIX}${wallet.trim().toLowerCase()}`;
}

export function createDefaultRecord(wallet, now = Date.now()) {
  return {
    version: NOTIFICATION_PREFS_VERSION,
    wallet: wallet.trim(),
    prefs: { ...DEFAULT_PREFS },
    updatedAt: now,
  };
}

/**
 * @param {unknown} raw
 * @param {string} wallet
 */
export function parsePrefsRecord(raw, wallet) {
  if (raw == null || raw === "") {
    return { ok: true, record: null, reason: "missing" };
  }
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, record: null, reason: "corrupt" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, record: null, reason: "corrupt" };
  }
  if (typeof parsed.version === "number" && parsed.version > NOTIFICATION_PREFS_VERSION) {
    return { ok: false, record: null, reason: "newer-version" };
  }
  const prefsIn = parsed.prefs && typeof parsed.prefs === "object" ? parsed.prefs : parsed;
  const prefs = { ...DEFAULT_PREFS };
  for (const key of OPTIONAL_PREF_KEYS) {
    if (typeof prefsIn[key] === "boolean") prefs[key] = prefsIn[key];
  }
  // Mandatory channel cannot be opted out via stored data.
  prefs.securityNotices = true;

  return {
    ok: true,
    record: {
      version: NOTIFICATION_PREFS_VERSION,
      wallet,
      prefs,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
    },
  };
}

/**
 * @param {{ getItem: Function, setItem: Function, removeItem: Function }} storage
 * @param {string|null|undefined} wallet
 */
export function loadNotificationPrefs(storage, wallet) {
  if (!wallet || !String(wallet).trim()) {
    return { ok: false, reason: "no-wallet", record: null };
  }
  const key = storageKeyForWallet(wallet);
  let raw;
  try {
    raw = storage.getItem(key);
  } catch (err) {
    return { ok: false, reason: "read-failed", record: null, error: String(err?.message || err) };
  }

  if (raw == null || raw === "") {
    // One-shot adopt legacy global key for this wallet.
    let legacy;
    try {
      legacy = storage.getItem(LEGACY_GLOBAL_KEY);
    } catch {
      legacy = null;
    }
    if (legacy) {
      const adopted = parsePrefsRecord(legacy, wallet);
      if (adopted.ok && adopted.record) {
        const write = saveNotificationPrefs(storage, wallet, adopted.record.prefs);
        if (write.ok) {
          try {
            storage.removeItem(LEGACY_GLOBAL_KEY);
          } catch {
            // ignore
          }
          return write;
        }
      }
    }
    return { ok: true, reason: "defaults", record: createDefaultRecord(wallet) };
  }

  const parsed = parsePrefsRecord(raw, wallet);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason, record: null };
  }
  return { ok: true, reason: "loaded", record: parsed.record };
}

/**
 * @param {{ getItem: Function, setItem: Function, removeItem: Function }} storage
 * @param {string} wallet
 * @param {Record<string, boolean>} prefs
 */
export function saveNotificationPrefs(storage, wallet, prefs, now = Date.now()) {
  if (!wallet || !String(wallet).trim()) {
    return { ok: false, reason: "no-wallet" };
  }
  const key = storageKeyForWallet(wallet);
  const nextPrefs = { ...DEFAULT_PREFS };
  for (const k of OPTIONAL_PREF_KEYS) {
    if (typeof prefs?.[k] === "boolean") nextPrefs[k] = prefs[k];
  }
  nextPrefs.securityNotices = true;

  const record = {
    version: NOTIFICATION_PREFS_VERSION,
    wallet: wallet.trim(),
    prefs: nextPrefs,
    updatedAt: now,
  };

  try {
    storage.setItem(key, JSON.stringify(record));
  } catch (err) {
    return { ok: false, reason: "write-failed", error: String(err?.message || err) };
  }
  return { ok: true, record };
}

/**
 * Producer gate: return whether a notification of `category` should be delivered.
 * Security notices always deliver.
 *
 * @param {object|null} prefsRecord
 * @param {string} category - round | action | prize | deposit | security
 */
export function shouldDeliverNotification(prefsRecord, category) {
  const prefKey = PRODUCER_CATEGORY_MAP[category];
  if (!prefKey) return false;
  if (MANDATORY_PREF_KEYS.includes(prefKey)) return true;
  const prefs = prefsRecord?.prefs || DEFAULT_PREFS;
  return prefs[prefKey] !== false;
}
