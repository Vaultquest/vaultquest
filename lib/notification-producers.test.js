import { describe, it, expect } from "vitest";
import {
  produceActionNotification,
  produceRoundNotification,
  producePrizeNotification,
  produceDepositNotification,
  produceSecurityNotification,
  loadPrefsFromStorage,
} from "./notification-producers.js";
import {
  saveNotificationPrefs,
  DEFAULT_PREFS,
  createDefaultRecord,
} from "./notification-prefs.js";

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
  };
}

const WALLET = "G".padEnd(56, "W");

describe("notification producers enforce prefs", () => {
  it("delivers defaults for action/round/prize and skips deposit by default", async () => {
    const record = createDefaultRecord(WALLET);
    expect((await produceActionNotification({ wallet: WALLET, send: () => {}, prefsRecord: record, payload: { id: 1 } })).delivered).toBe(true);
    expect((await produceRoundNotification({ wallet: WALLET, send: () => {}, prefsRecord: record, payload: { id: 2 } })).delivered).toBe(true);
    expect((await producePrizeNotification({ wallet: WALLET, send: () => {}, prefsRecord: record, payload: { id: 3 } })).delivered).toBe(true);
    expect((await produceDepositNotification({ wallet: WALLET, send: () => {}, prefsRecord: record, payload: { id: 4 } })).delivered).toBe(false);
  });

  it("honors opt-out and opt-in", async () => {
    const storage = memoryStorage();
    saveNotificationPrefs(storage, WALLET, {
      ...DEFAULT_PREFS,
      actionStatus: false,
      deposits: true,
      winnings: false,
    });
    const record = loadPrefsFromStorage(storage, WALLET);
    expect((await produceActionNotification({ wallet: WALLET, send: () => {}, prefsRecord: record, payload: {} })).skipped).toBe(true);
    expect((await produceDepositNotification({ wallet: WALLET, send: () => {}, prefsRecord: record, payload: {} })).delivered).toBe(true);
    expect((await producePrizeNotification({ wallet: WALLET, send: () => {}, prefsRecord: record, payload: {} })).delivered).toBe(false);
  });

  it("always delivers security notices even if prefs tampered", async () => {
    const record = createDefaultRecord(WALLET);
    record.prefs.securityNotices = false;
    const result = await produceSecurityNotification({
      wallet: WALLET, send: () => {},
      prefsRecord: record,
      payload: { kind: "login" },
    });
    expect(result.delivered).toBe(true);
  });

  it("isolates wallets when switching", async () => {
    const storage = memoryStorage();
    const other = "G".padEnd(56, "X");
    saveNotificationPrefs(storage, WALLET, { ...DEFAULT_PREFS, roundUpdates: false });
    saveNotificationPrefs(storage, other, { ...DEFAULT_PREFS, roundUpdates: true });
    const a = loadPrefsFromStorage(storage, WALLET);
    const b = loadPrefsFromStorage(storage, other);
    expect((await produceRoundNotification({ wallet: WALLET, send: () => {}, prefsRecord: a, payload: {} })).delivered).toBe(false);
    expect((await produceRoundNotification({ wallet: other, send: () => {}, prefsRecord: b, payload: {} })).delivered).toBe(true);
  });

  it("invokes send only when delivery is allowed", async () => {
    const sent = [];
    const record = createDefaultRecord(WALLET);
    record.prefs.deposits = false;
    await produceDepositNotification({
      wallet: WALLET,
      prefsRecord: record,
      payload: { amount: "1" },
      send: (m) => sent.push(m),
    });
    await producePrizeNotification({
      wallet: WALLET,
      prefsRecord: record,
      payload: { prize: "yes" },
      send: (m) => sent.push(m),
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].category).toBe("prize");
  });

  it("does not claim delivery without a sender", async () => {
    const result = await produceActionNotification({ wallet: WALLET, payload: {} });
    expect(result).toMatchObject({ delivered: false, skipped: true, reason: "no-sender" });
  });

  it("sends mandatory security notices even if optional preference storage is unavailable", async () => {
    const sent = [];
    const result = await produceSecurityNotification({
      wallet: WALLET,
      payload: { kind: "security" },
      loadPrefs: () => { throw new Error("store unavailable"); },
      send: message => sent.push(message),
    });
    expect(result.delivered).toBe(true);
    expect(sent).toHaveLength(1);
  });
});
