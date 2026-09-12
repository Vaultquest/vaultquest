import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GOALS_STORAGE_VERSION,
  LEGACY_STORAGE_KEY,
  goalStorageKey,
  readGoal,
  removeGoal,
  writeGoal,
} from "./vault-goals-storage";

const WALLET_A = "GA".padEnd(56, "A");
const WALLET_B = "GB".padEnd(56, "B");

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

let storage;

beforeEach(() => {
  storage = memoryStorage();
});

describe("wallet scoping", () => {
  it("is empty for a wallet that has never saved a goal", () => {
    expect(readGoal(storage, WALLET_A)).toEqual({ status: "empty", goal: null, reason: null });
  });

  it("stores a goal under the owning wallet and reads it back", () => {
    const written = writeGoal(storage, WALLET_A, 5000, { now: 1000 });
    expect(written.ok).toBe(true);

    const read = readGoal(storage, WALLET_A);
    expect(read.status).toBe("ok");
    expect(read.goal.amount).toBe(5000);
    expect(read.goal.wallet).toBe(WALLET_A.toLowerCase());
  });

  it("never shows one wallet the goal of another", () => {
    writeGoal(storage, WALLET_A, 5000);
    expect(readGoal(storage, WALLET_B).status).toBe("empty");
  });

  it("treats a wallet key case-insensitively", () => {
    writeGoal(storage, WALLET_A, 5000);
    expect(readGoal(storage, WALLET_A.toLowerCase()).goal.amount).toBe(5000);
  });

  it("removing a goal only affects the owning wallet", () => {
    writeGoal(storage, WALLET_A, 5000);
    writeGoal(storage, WALLET_B, 900);
    expect(removeGoal(storage, WALLET_A).ok).toBe(true);
    expect(readGoal(storage, WALLET_A).status).toBe("empty");
    expect(readGoal(storage, WALLET_B).goal.amount).toBe(900);
  });
});

describe("missing wallet", () => {
  it("reports a no-wallet state instead of falling back to a global goal", () => {
    const read = readGoal(storage, "");
    expect(read.status).toBe("no-wallet");
    expect(read.goal).toBeNull();
  });

  it("refuses to write without a wallet and says why", () => {
    const written = writeGoal(storage, null, 5000);
    expect(written.ok).toBe(false);
    expect(written.reason).toMatch(/connect a wallet/i);
  });
});

describe("corrupt and incompatible records", () => {
  it("reports unreadable JSON without overwriting it", () => {
    storage.setItem(goalStorageKey(WALLET_A), "{not json");
    const read = readGoal(storage, WALLET_A);
    expect(read.status).toBe("error");
    expect(storage.getItem(goalStorageKey(WALLET_A))).toBe("{not json");
  });

  it("reports a record from a newer app version rather than clobbering it", () => {
    storage.setItem(
      goalStorageKey(WALLET_A),
      JSON.stringify({ version: GOALS_STORAGE_VERSION + 1, amount: 100, wallet: WALLET_A })
    );
    const read = readGoal(storage, WALLET_A);
    expect(read.status).toBe("error");
    expect(read.reason).toMatch(/newer version/i);
  });

  it("rejects a record whose amount is not a positive number", () => {
    storage.setItem(
      goalStorageKey(WALLET_A),
      JSON.stringify({ version: GOALS_STORAGE_VERSION, amount: 0, wallet: WALLET_A })
    );
    expect(readGoal(storage, WALLET_A).status).toBe("error");
  });

  it("surfaces storage read failures instead of reporting an empty goal", () => {
    const broken = {
      getItem: vi.fn(() => {
        throw new Error("SecurityError");
      }),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    const read = readGoal(broken, WALLET_A);
    expect(read.status).toBe("error");
    expect(read.reason).toMatch(/unavailable/i);
  });

  it("surfaces storage write failures instead of claiming a save", () => {
    const broken = {
      getItem: () => null,
      setItem: vi.fn(() => {
        throw new Error("QuotaExceededError");
      }),
      removeItem: vi.fn(),
    };
    const written = writeGoal(broken, WALLET_A, 5000);
    expect(written.ok).toBe(false);
    expect(written.reason).toMatch(/refused to store/i);
  });
});

describe("migration from the pre-#119 global key", () => {
  it("adopts the legacy goal once, for the connected wallet, then deletes it", () => {
    storage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ amount: 750, createdAt: 42 }));

    const first = readGoal(storage, WALLET_A, { now: 999 });
    expect(first.status).toBe("ok");
    expect(first.migratedFromLegacy).toBe(true);
    expect(first.goal.amount).toBe(750);
    expect(first.goal.createdAt).toBe(42);
    expect(first.goal.version).toBe(GOALS_STORAGE_VERSION);

    expect(storage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
    // The second wallet must not inherit the adopted goal.
    expect(readGoal(storage, WALLET_B).status).toBe("empty");
  });

  it("upgrades an unowned record in place", () => {
    storage.setItem(goalStorageKey(WALLET_A), JSON.stringify({ amount: 300, createdAt: 7 }));
    const read = readGoal(storage, WALLET_A, { now: 1000 });
    expect(read.status).toBe("ok");
    expect(read.goal.version).toBe(GOALS_STORAGE_VERSION);
    expect(read.goal.createdAt).toBe(7);
    expect(read.goal.updatedAt).toBe(1000);
  });

  it("ignores a legacy value that is not a usable goal", () => {
    storage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({ amount: -5 }));
    expect(readGoal(storage, WALLET_A).status).toBe("empty");
  });
});

describe("concurrent edits", () => {
  it("keeps the newest amount and preserves the original creation time", () => {
    writeGoal(storage, WALLET_A, 5000, { now: 1000 });
    const second = writeGoal(storage, WALLET_A, 8000, { now: 2000 });
    expect(second.goal.amount).toBe(8000);
    expect(second.goal.createdAt).toBe(1000);
    expect(second.goal.updatedAt).toBe(2000);
    expect(readGoal(storage, WALLET_A).goal.amount).toBe(8000);
  });

  it("lets another tab's newer write win on the next read", () => {
    writeGoal(storage, WALLET_A, 5000, { now: 1000 });
    writeGoal(storage, WALLET_A, 6500, { now: 5000 });
    expect(readGoal(storage, WALLET_A).goal.updatedAt).toBe(5000);
    expect(readGoal(storage, WALLET_A).goal.amount).toBe(6500);
  });
});
