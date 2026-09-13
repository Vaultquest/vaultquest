/**
 * Notification Preferences Store & Delivery Policy (#118).
 *
 * Persists versioned notification settings scoped to the connected wallet principal.
 * Separates mandatory security notices from optional user preferences and enforces
 * delivery filters across action, round, prize, and deposit producers.
 */

export const STORAGE_VERSION = 1;
export const KEY_PREFIX = "vq_notif_prefs:v1:";
export const PREFS_UPDATED_EVENT = "vaultquest-notif-prefs-updated";

export const DEFAULT_PREFERENCES = {
  roundUpdates: true,
  actionStatus: true,
  winnings: true,
  deposits: false,
};

export const MANDATORY_SECURITY_NOTICES = [
  {
    key: "securityAlerts",
    label: "Security & Emergency Notices",
    description: "Critical alerts regarding contract pause, emergency evacuation, or protocol incidents.",
    mandatory: true,
  },
  {
    key: "signerModifications",
    label: "Signer & Auth Modifications",
    description: "Immediate warnings when multisig signers, keys, or security thresholds are modified.",
    mandatory: true,
  },
];

export const OPTIONAL_PREFERENCE_FIELDS = [
  {
    key: "roundUpdates",
    label: "Round Updates",
    description: "Get notified when weekly prize rounds complete and new draws open.",
  },
  {
    key: "actionStatus",
    label: "Action Status Updates",
    description: "Status notifications for in-flight deposits, withdrawals, and claims.",
  },
  {
    key: "winnings",
    label: "Winning Notifications",
    description: "Real-time alerts when your tickets win a pool prize draw.",
  },
  {
    key: "deposits",
    label: "Deposit Confirmations",
    description: "Individual ledger confirmation notifications for each deposit.",
  },
];

/**
 * Derives a canonical storage key for a wallet address.
 * @param {string} walletAddress
 * @returns {string | null}
 */
export function getStorageKey(walletAddress) {
  if (!walletAddress || typeof walletAddress !== "string") return null;
  const normalized = walletAddress.trim().toLowerCase();
  return `${KEY_PREFIX}${normalized}`;
}

/**
 * Reads notification preferences for a specific wallet address.
 * Falls back to DEFAULT_PREFERENCES on missing, corrupted, or incompatible data.
 * @param {string} walletAddress
 * @returns {typeof DEFAULT_PREFERENCES}
 */
export function getNotificationPreferences(walletAddress) {
  if (!walletAddress || typeof window === "undefined") {
    return { ...DEFAULT_PREFERENCES };
  }

  const key = getStorageKey(walletAddress);
  if (!key) return { ...DEFAULT_PREFERENCES };

  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { ...DEFAULT_PREFERENCES };

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { ...DEFAULT_PREFERENCES };
    }

    const categories = parsed.categories || parsed;
    return {
      roundUpdates:
        typeof categories.roundUpdates === "boolean"
          ? categories.roundUpdates
          : DEFAULT_PREFERENCES.roundUpdates,
      actionStatus:
        typeof categories.actionStatus === "boolean"
          ? categories.actionStatus
          : DEFAULT_PREFERENCES.actionStatus,
      winnings:
        typeof categories.winnings === "boolean"
          ? categories.winnings
          : DEFAULT_PREFERENCES.winnings,
      deposits:
        typeof categories.deposits === "boolean"
          ? categories.deposits
          : DEFAULT_PREFERENCES.deposits,
    };
  } catch (err) {
    console.warn("Failed to load notification preferences for", walletAddress, err);
    return { ...DEFAULT_PREFERENCES };
  }
}

/**
 * Persists versioned notification preferences scoped to a wallet.
 * @param {string} walletAddress
 * @param {Partial<typeof DEFAULT_PREFERENCES>} preferences
 * @returns {boolean}
 */
export function saveNotificationPreferences(walletAddress, preferences) {
  if (!walletAddress || typeof walletAddress !== "string" || !walletAddress.trim()) {
    throw new Error("A connected wallet address is required to save notification preferences.");
  }
  if (typeof window === "undefined") {
    return false;
  }

  const key = getStorageKey(walletAddress);
  if (!key) {
    throw new Error("Unable to derive storage key for wallet address.");
  }

  const sanitized = {
    roundUpdates: Boolean(preferences?.roundUpdates),
    actionStatus: Boolean(preferences?.actionStatus),
    winnings: Boolean(preferences?.winnings),
    deposits: Boolean(preferences?.deposits),
  };

  const record = {
    version: STORAGE_VERSION,
    walletAddress: walletAddress.trim(),
    updatedAt: new Date().toISOString(),
    categories: sanitized,
  };

  try {
    localStorage.setItem(key, JSON.stringify(record));
    window.dispatchEvent(
      new CustomEvent(PREFS_UPDATED_EVENT, {
        detail: { walletAddress: walletAddress.trim(), preferences: sanitized },
      })
    );
    return true;
  } catch (err) {
    console.error("Storage write failure for notification preferences:", err);
    throw err;
  }
}

/**
 * Checks whether a notification should be delivered based on wallet preferences.
 * Mandatory security notices are ALWAYS delivered and cannot be silenced.
 * @param {string | null | undefined} walletAddress
 * @param {string} category
 * @param {boolean} [isSecurityAlert=false]
 * @returns {boolean}
 */
export function shouldDeliverNotification(walletAddress, category, isSecurityAlert = false) {
  // Mandatory security notices MUST always deliver
  if (
    isSecurityAlert ||
    category === "securityAlerts" ||
    category === "signerModifications" ||
    category === "security"
  ) {
    return true;
  }

  if (!category) return false;

  const prefs = getNotificationPreferences(walletAddress || "");
  return Boolean(prefs[category]);
}
