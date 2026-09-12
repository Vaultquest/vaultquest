/**
 * Wallet-scoped storage for the savings goal tracker (#119).
 *
 * The tracker used to live under one browser-wide key (`vq_goal_tracker`), so
 * switching wallets in the same browser showed - and let the next user edit -
 * the previous wallet's target. Storage failures were swallowed, so a target
 * that never persisted looked saved.
 *
 * Rules this module enforces:
 * - a goal is always keyed by the wallet that owns it; there is no global
 *   fallback, and a missing wallet is an explicit state rather than a
 *   best-effort read;
 * - records are versioned, and a record written by a *newer* version is
 *   reported as an error instead of being overwritten with yesterday's shape;
 * - every write reports success or a reason, so the UI can stop claiming a
 *   save that did not happen.
 *
 * Storage is injected, so the whole contract is tested without a browser.
 */

export const GOALS_STORAGE_VERSION = 2;

/** Pre-#119 key. Read once for migration, then deleted. */
export const LEGACY_STORAGE_KEY = "vq_goal_tracker";

export const GOAL_KEY_PREFIX = "vq_goal_tracker:v2:";

/** Stellar public keys are case-insensitive here; storage keys are not. */
export function normalizeWallet(wallet) {
  if (typeof wallet !== "string") return null;
  const trimmed = wallet.trim().toLowerCase();
  return trimmed === "" ? null : trimmed;
}

export function goalStorageKey(wallet) {
  const normalized = normalizeWallet(wallet);
  return normalized === null ? null : GOAL_KEY_PREFIX + normalized;
}

function isValidAmount(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function safeGet(storage, key) {
  try {
    return { ok: true, value: storage.getItem(key) };
  } catch {
    return { ok: false, value: null };
  }
}

function safeSet(storage, key, value) {
  try {
    storage.setItem(key, value);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

function safeRemove(storage, key) {
  try {
    storage.removeItem(key);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

function makeGoal(amount, wallet, now, createdAt) {
  return {
    version: GOALS_STORAGE_VERSION,
    wallet,
    amount,
    createdAt: typeof createdAt === "number" ? createdAt : now,
    updatedAt: now,
  };
}

/**
 * Read the goal for one wallet.
 *
 * @returns {{ status: "ok"|"empty"|"no-wallet"|"error", goal: object|null, reason: string|null, migratedFromLegacy?: boolean }}
 */
export function readGoal(storage, wallet, options = {}) {
  const now = options.now ?? Date.now();
  const normalized = normalizeWallet(wallet);

  if (normalized === null) {
    return {
      status: "no-wallet",
      goal: null,
      reason: "Connect a wallet to see your savings goal.",
    };
  }

  const key = goalStorageKey(normalized);
  const stored = safeGet(storage, key);
  if (!stored.ok) {
    return {
      status: "error",
      goal: null,
      reason: "Browser storage is unavailable, so your goal cannot be read or saved.",
    };
  }

  const raw = stored.value;
  if (raw !== null && raw !== undefined) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        status: "error",
        goal: null,
        reason: "Stored goal data is not readable. It has been left untouched.",
      };
    }

    if (!parsed || typeof parsed !== "object" || !isValidAmount(parsed.amount)) {
      return {
        status: "error",
        goal: null,
        reason: "Stored goal data is not a valid goal. It has been left untouched.",
      };
    }

    const version = parsed.version;

    if (version === undefined) {
      // Pre-#119 records were { amount, createdAt } with no owner. They are
      // claimed by the wallet that is connected now, because the old key
      // carried no wallet to attribute them to.
      const migrated = makeGoal(parsed.amount, normalized, now, parsed.createdAt);
      const written = safeSet(storage, key, JSON.stringify(migrated));
      if (!written.ok) {
        return {
          status: "error",
          goal: null,
          reason: "Could not migrate your saved goal into wallet-scoped storage.",
        };
      }
      return { status: "ok", goal: migrated, reason: null, migratedFromLegacy: true };
    }

    if (version > GOALS_STORAGE_VERSION) {
      return {
        status: "error",
        goal: null,
        reason:
          "This goal was saved by a newer version of the app. Update to edit it.",
      };
    }

    if (version < GOALS_STORAGE_VERSION) {
      const migrated = makeGoal(parsed.amount, normalized, now, parsed.createdAt);
      const written = safeSet(storage, key, JSON.stringify(migrated));
      if (!written.ok) {
        return {
          status: "error",
          goal: null,
          reason: "Could not upgrade your saved goal to the current format.",
        };
      }
      return { status: "ok", goal: migrated, reason: null };
    }

    return { status: "ok", goal: parsed, reason: null };
  }

  // No wallet-scoped record: adopt the legacy global one exactly once, for the
  // wallet that is connected now, then delete it so no other wallet inherits it.
  const legacy = safeGet(storage, LEGACY_STORAGE_KEY);
  if (legacy.ok && legacy.value !== null && legacy.value !== undefined) {
    let parsedLegacy = null;
    try {
      parsedLegacy = JSON.parse(legacy.value);
    } catch {
      parsedLegacy = null;
    }
    if (parsedLegacy && isValidAmount(parsedLegacy.amount)) {
      const adopted = makeGoal(
        parsedLegacy.amount,
        normalized,
        now,
        parsedLegacy.createdAt
      );
      const written = safeSet(storage, key, JSON.stringify(adopted));
      if (written.ok) {
        safeRemove(storage, LEGACY_STORAGE_KEY);
        return { status: "ok", goal: adopted, reason: null, migratedFromLegacy: true };
      }
      return {
        status: "error",
        goal: null,
        reason: "Could not migrate your saved goal into wallet-scoped storage.",
      };
    }
  }

  return { status: "empty", goal: null, reason: null };
}

/** @returns {{ ok: boolean, goal?: object, reason?: string }} */
export function writeGoal(storage, wallet, amount, options = {}) {
  const now = options.now ?? Date.now();
  const normalized = normalizeWallet(wallet);

  if (normalized === null) {
    return { ok: false, reason: "Connect a wallet before setting a goal." };
  }
  if (!isValidAmount(amount)) {
    return { ok: false, reason: "Enter a goal amount greater than zero." };
  }

  const key = goalStorageKey(normalized);
  const existing = readGoal(storage, normalized, { now });
  const goal = makeGoal(
    amount,
    normalized,
    now,
    existing.status === "ok" && existing.goal ? existing.goal.createdAt : undefined
  );

  const written = safeSet(storage, key, JSON.stringify(goal));
  if (!written.ok) {
    return {
      ok: false,
      reason: "Your browser refused to store the goal, so it was not saved.",
    };
  }
  return { ok: true, goal };
}

/** @returns {{ ok: boolean, reason?: string }} */
export function removeGoal(storage, wallet) {
  const normalized = normalizeWallet(wallet);
  if (normalized === null) {
    return { ok: false, reason: "Connect a wallet before removing a goal." };
  }
  const removed = safeRemove(storage, goalStorageKey(normalized));
  if (!removed.ok) {
    return { ok: false, reason: "Your browser refused to remove the stored goal." };
  }
  return { ok: true };
}

const vaultGoalsStorage = {
  readGoal,
  writeGoal,
  removeGoal,
  goalStorageKey,
  normalizeWallet,
  GOALS_STORAGE_VERSION,
};

export default vaultGoalsStorage;
