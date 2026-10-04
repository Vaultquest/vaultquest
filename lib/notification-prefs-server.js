/**
 * Server-side durable notification prefs (#118).
 * File-backed JSON map keyed by wallet; tests inject Memory store.
 */

import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  DEFAULT_PREFS,
  NOTIFICATION_PREFS_VERSION,
  OPTIONAL_PREF_KEYS,
  createDefaultRecord,
  parsePrefsRecord,
} from "./notification-prefs.js";

function createServerRecord(wallet, prefs, now = Date.now()) {
  if (!wallet || !String(wallet).trim()) {
    const err = new Error("wallet is required");
    err.code = "NO_WALLET";
    throw err;
  }
  const next = { ...DEFAULT_PREFS };
  for (const k of OPTIONAL_PREF_KEYS) {
    if (typeof prefs?.[k] === "boolean") next[k] = prefs[k];
  }
  next.securityNotices = true;
  return {
    version: NOTIFICATION_PREFS_VERSION,
    wallet: wallet.trim(),
    prefs: next,
    updatedAt: now,
  };
}

export class MemoryNotificationPrefsServerStore {
  constructor() {
    this.byWallet = new Map();
  }

  async get(wallet) {
    if (!wallet) return createDefaultRecord("anonymous");
    const existing = this.byWallet.get(wallet.trim().toLowerCase());
    if (!existing) return createDefaultRecord(wallet);
    return existing;
  }

  async put(wallet, prefs, now = Date.now()) {
    const record = createServerRecord(wallet, prefs, now);
    this.byWallet.set(wallet.trim().toLowerCase(), record);
    await this.persistAll?.();
    return record;
  }
}

export class FileNotificationPrefsServerStore extends MemoryNotificationPrefsServerStore {
  constructor(filePath) {
    super();
    this.filePath = filePath;
    this._loaded = false;
    this._loadPromise = null;
    this._writePromise = Promise.resolve();
  }

  async ensureLoaded() {
    if (this._loaded) return;
    if (!this._loadPromise) {
      this._loadPromise = (async () => {
        const nextWallets = new Map();
        try {
          const raw = await fs.readFile(this.filePath, "utf8");
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("stored notification preferences are invalid");
          }
          for (const [wallet, record] of Object.entries(parsed)) {
            const result = parsePrefsRecord(record, wallet);
            if (!result.ok || !result.record) {
              throw new Error("stored notification preference record is invalid");
            }
            nextWallets.set(wallet.toLowerCase(), result.record);
          }
        } catch (err) {
          if (err?.code !== "ENOENT") throw err;
        }
        // A failed read must remain retryable and must never enable empty saves.
        this.byWallet = nextWallets;
        this._loaded = true;
      })();
    }
    const loading = this._loadPromise;
    try {
      await loading;
    } finally {
      if (this._loadPromise === loading) this._loadPromise = null;
    }
  }

  async persistAll(records = this.byWallet) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(
        temporaryPath,
        JSON.stringify(Object.fromEntries(records.entries()), null, 2),
        { encoding: "utf8", flag: "wx" },
      );
      // Keep the previous complete file if writing or replacing it fails.
      await fs.rename(temporaryPath, this.filePath);
    } finally {
      await fs.unlink(temporaryPath).catch(() => {});
    }
  }

  async get(wallet) {
    await this.ensureLoaded();
    return super.get(wallet);
  }

  async put(wallet, prefs, now) {
    await this.ensureLoaded();
    const record = createServerRecord(wallet, prefs, now);
    const writing = this._writePromise.then(async () => {
      const nextWallets = new Map(this.byWallet);
      nextWallets.set(wallet.trim().toLowerCase(), record);
      await this.persistAll(nextWallets);
      this.byWallet = nextWallets;
      return record;
    });
    // Failed saves reject their caller without poisoning later queued saves.
    this._writePromise = writing.catch(() => {});
    return writing;
  }
}

let singleton;
export function getNotificationPrefsServerStore() {
  if (!singleton) {
    const filePath =
      process.env.NOTIFICATION_PREFS_STORE_PATH ||
      path.join(process.cwd(), ".data", "notification-prefs.json");
    singleton = new FileNotificationPrefsServerStore(filePath);
  }
  return singleton;
}

export function resetNotificationPrefsServerStoreForTests(store) {
  singleton = store || null;
}
