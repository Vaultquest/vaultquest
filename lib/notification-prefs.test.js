import { describe, it, expect } from "vitest";
import {
  loadNotificationPrefs,
  saveNotificationPrefs,
  shouldDeliverNotification,
  DEFAULT_PREFS,
  LEGACY_GLOBAL_KEY,
  storageKeyForWallet,
  createDefaultRecord,
} from "./notification-prefs.js";
import { MemoryNotificationPrefsServerStore } from "./notification-prefs-server.js";

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      map.set(k, String(v));
    },
    removeItem: (k) => {
      map.delete(k);
    },
    _map: map,
  };
}

const WALLET_A = "G".padEnd(56, "A");
const WALLET_B = "G".padEnd(56, "B");

describe("notification prefs storage", () => {
  it("returns defaults for a wallet with no saved prefs", () => {
    const storage = memoryStorage();
    const result = loadNotificationPrefs(storage, WALLET_A);
    expect(result.ok).toBe(true);
    expect(result.record.prefs).toEqual(DEFAULT_PREFS);
  });

  it("requires a wallet", () => {
    const storage = memoryStorage();
    expect(loadNotificationPrefs(storage, "").reason).toBe("no-wallet");
    expect(saveNotificationPrefs(storage, "", DEFAULT_PREFS).reason).toBe("no-wallet");
  });

  it("persists opt-in/out and reloads per wallet", () => {
    const storage = memoryStorage();
    saveNotificationPrefs(storage, WALLET_A, {
      ...DEFAULT_PREFS,
      deposits: true,
      winnings: false,
    });
    saveNotificationPrefs(storage, WALLET_B, {
      ...DEFAULT_PREFS,
      roundUpdates: false,
    });

    const a = loadNotificationPrefs(storage, WALLET_A);
    const b = loadNotificationPrefs(storage, WALLET_B);
    expect(a.record.prefs.deposits).toBe(true);
    expect(a.record.prefs.winnings).toBe(false);
    expect(b.record.prefs.roundUpdates).toBe(false);
    expect(b.record.prefs.deposits).toBe(false);
    expect(storageKeyForWallet(WALLET_A)).not.toBe(storageKeyForWallet(WALLET_B));
  });

  it("keeps wallets isolated when switching", () => {
    const storage = memoryStorage();
    saveNotificationPrefs(storage, WALLET_A, { ...DEFAULT_PREFS, deposits: true });
    const b = loadNotificationPrefs(storage, WALLET_B);
    expect(b.record.prefs.deposits).toBe(false);
  });

  it("refuses to overwrite a newer-version record", () => {
    const storage = memoryStorage({
      [storageKeyForWallet(WALLET_A)]: JSON.stringify({
        version: 99,
        wallet: WALLET_A,
        prefs: DEFAULT_PREFS,
      }),
    });
    const loaded = loadNotificationPrefs(storage, WALLET_A);
    expect(loaded.ok).toBe(false);
    expect(loaded.reason).toBe("newer-version");
  });

  it("adopts a legacy global key once for the connected wallet", () => {
    const storage = memoryStorage({
      [LEGACY_GLOBAL_KEY]: JSON.stringify({
        roundUpdates: false,
        actionStatus: true,
        winnings: true,
        deposits: true,
      }),
    });
    const first = loadNotificationPrefs(storage, WALLET_A);
    expect(first.ok).toBe(true);
    expect(first.record.prefs.roundUpdates).toBe(false);
    expect(first.record.prefs.deposits).toBe(true);
    expect(storage.getItem(LEGACY_GLOBAL_KEY)).toBeNull();

    // Second wallet does not re-adopt.
    const second = loadNotificationPrefs(storage, WALLET_B);
    expect(second.record.prefs.roundUpdates).toBe(true);
  });

  it("surfaces write failures", () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {},
    };
    const result = saveNotificationPrefs(storage, WALLET_A, DEFAULT_PREFS);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("write-failed");
  });
});

describe("shouldDeliverNotification", () => {
  it("always delivers security notices", () => {
    const record = createDefaultRecord(WALLET_A);
    record.prefs.securityNotices = false; // even if tampered
    expect(shouldDeliverNotification(record, "security")).toBe(true);
  });

  it("honors optional producer categories", () => {
    const record = createDefaultRecord(WALLET_A);
    record.prefs.winnings = false;
    record.prefs.deposits = true;
    expect(shouldDeliverNotification(record, "prize")).toBe(false);
    expect(shouldDeliverNotification(record, "deposit")).toBe(true);
    expect(shouldDeliverNotification(record, "round")).toBe(true);
    expect(shouldDeliverNotification(record, "action")).toBe(true);
  });

  it("uses defaults when no record is present", () => {
    expect(shouldDeliverNotification(null, "deposit")).toBe(false);
    expect(shouldDeliverNotification(null, "prize")).toBe(true);
  });
});

describe("server store", () => {
  it("stores concurrent-ish updates keeping the latest prefs", async () => {
    const store = new MemoryNotificationPrefsServerStore();
    await store.put(WALLET_A, { ...DEFAULT_PREFS, deposits: true }, 1);
    const latest = await store.put(WALLET_A, { ...DEFAULT_PREFS, deposits: false, winnings: false }, 2);
    expect(latest.prefs.deposits).toBe(false);
    expect(latest.prefs.winnings).toBe(false);
    expect(latest.updatedAt).toBe(2);
  });
});
