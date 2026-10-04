/**
 * Durable support-ticket store (#117).
 *
 * Default implementation appends JSON lines to a file under `.data/` so
 * acceptance survives process restarts on a single host. Tests inject an
 * in-memory store. Rate limits and idempotency live here so the HTTP layer
 * stays thin.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  duplicateFingerprint,
  mintReceiptId,
  validateTicketInput,
} from "./support-tickets.js";

export const DEFAULT_RATE_LIMIT = { max: 5, windowMs: 15 * 60 * 1000 };
export const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const RECEIPT_ID_ATTEMPTS = 8;
const IDEMPOTENCY_ALIAS_RECORD = "idempotency_alias";

// Similarity-based duplicates may differ from the canonical ticket's exact
// validated text. Bind each acknowledged key to the payload it accepted.
function idempotencyPayloadDigest(ticket) {
  const fields = [
    "name", "email", "category", "description", "wallet_address", "schema_version",
  ];
  return createHash("sha256")
    .update(JSON.stringify(fields.map((field) => ticket[field])))
    .digest("hex");
}

// Similar text is not the same support request when the submitter or wallet
// context changes. Keep the existing text normalization, but partition its
// duplicate index by the validated fields that must be durably bound.
function duplicateTicketKey(ticket) {
  return JSON.stringify([
    duplicateFingerprint(ticket), ticket.name, ticket.wallet_address ?? null,
  ]);
}

/**
 * @typedef {object} StoredTicket
 * @property {string} id
 * @property {string} status
 * @property {number} created_at
 * @property {string} name
 * @property {string} email
 * @property {string} category
 * @property {string} description
 * @property {string|null} wallet_address
 * @property {string|null} idempotency_key
 * @property {number} schema_version
 */

export class MemorySupportTicketStore {
  constructor(options = {}) {
    this.tickets = new Map();
    this.byIdempotency = new Map();
    this.idempotencyDigests = new Map();
    this.rate = new Map();
    this.duplicates = new Map();
    this.rateLimit = options.rateLimit || DEFAULT_RATE_LIMIT;
    this.now = options.now || (() => Date.now());
    this.random = options.random || Math.random;
    this.failNext = false;
  }

  simulateOutage() {
    this.failNext = true;
  }

  /**
   * @param {object} input
   * @param {{ clientKey: string }} meta
   */
  async create(input, meta) {
    if (this.failNext) {
      this.failNext = false;
      const err = new Error("support store unavailable");
      err.code = "STORE_UNAVAILABLE";
      throw err;
    }

    const validated = validateTicketInput(input);
    if (!validated.ok) {
      const err = new Error(validated.message);
      err.code = validated.code;
      err.fieldErrors = validated.fieldErrors;
      throw err;
    }

    const ticket = validated.ticket;
    const now = this.now();

    if (ticket.idempotency_key) {
      const existingId = this.byIdempotency.get(ticket.idempotency_key);
      if (existingId) {
        const existing = this.tickets.get(existingId);
        if (existing) {
          // Only an identical validated submission may reuse its receipt.
          const acceptedDigest = this.idempotencyDigests.get(ticket.idempotency_key);
          const changed = acceptedDigest !== undefined
            ? idempotencyPayloadDigest(ticket) !== acceptedDigest
            : [
              "name", "email", "category", "description", "wallet_address", "schema_version",
            ].some((field) => ticket[field] !== existing[field]);
          if (changed) {
            const err = new Error("idempotency key was used for different ticket details");
            err.code = "IDEMPOTENCY_CONFLICT";
            throw err;
          }
          return { ticket: existing, duplicate: true };
        }
      }
    }

    const rateKey = meta.clientKey || ticket.email;
    const window = this.rate.get(rateKey);
    if (!window || now >= window.resetAt) {
      this.rate.set(rateKey, { count: 1, resetAt: now + this.rateLimit.windowMs });
    } else {
      window.count += 1;
      if (window.count > this.rateLimit.max) {
        const err = new Error("rate limit exceeded");
        err.code = "RATE_LIMITED";
        err.retryAfterMs = Math.max(0, window.resetAt - now);
        throw err;
      }
    }

    const dupKey = duplicateTicketKey(ticket);
    const priorDup = this.duplicates.get(dupKey);
    if (priorDup && now - priorDup.at < DUPLICATE_WINDOW_MS) {
      const existing = this.tickets.get(priorDup.id);
      if (existing) {
        if (ticket.idempotency_key) {
          const alias = {
            record_type: IDEMPOTENCY_ALIAS_RECORD,
            schema_version: 1,
            idempotency_key: ticket.idempotency_key,
            ticket_id: existing.id,
            input_digest: idempotencyPayloadDigest(ticket),
          };
          // A duplicate response acknowledges this new key too. Persist its
          // binding before exposing it, without rewriting or re-aging the ticket.
          if (this.persist) await this.persist(alias);
          this.byIdempotency.set(alias.idempotency_key, alias.ticket_id);
          this.idempotencyDigests.set(alias.idempotency_key, alias.input_digest);
        }
        return { ticket: existing, duplicate: true };
      }
    }

    // A receipt must never replace an accepted ticket or redirect its retries.
    // File-backed creates hold their queue slot after loading existing IDs.
    let id;
    for (let attempt = 0; attempt < RECEIPT_ID_ATTEMPTS; attempt += 1) {
      const candidate = mintReceiptId({ now: () => now, random: this.random });
      if (!this.tickets.has(candidate)) {
        id = candidate;
        break;
      }
    }
    if (!id) {
      const err = new Error("could not allocate a unique support receipt");
      err.code = "STORE_UNAVAILABLE";
      throw err;
    }
    /** @type {StoredTicket} */
    const stored = {
      id,
      status: "accepted",
      created_at: now,
      name: ticket.name,
      email: ticket.email,
      category: ticket.category,
      description: ticket.description,
      wallet_address: ticket.wallet_address,
      idempotency_key: ticket.idempotency_key,
      schema_version: ticket.schema_version,
    };

    // Only persisted receipts may be returned by get() or duplicate retries.
    if (this.persist) await this.persist(stored);
    this.tickets.set(id, stored);
    if (ticket.idempotency_key) {
      this.byIdempotency.set(ticket.idempotency_key, id);
    }
    this.duplicates.set(dupKey, { id, at: now });
    return { ticket: stored, duplicate: false };
  }

  async get(id) {
    return this.tickets.get(id) || null;
  }
}

/**
 * File-backed store. Loads existing JSONL on construct; appends on create.
 */
export class FileSupportTicketStore extends MemorySupportTicketStore {
  /**
   * @param {string} filePath
   * @param {object} [options]
   */
  constructor(filePath, options = {}) {
    super(options);
    this.filePath = filePath;
    this._loaded = false;
    this._loadPromise = null;
    this._createQueue = Promise.resolve();
    this._needsLineBoundary = false;
  }

  async ensureLoaded() {
    if (this._loaded) return;
    if (!this._loadPromise) {
      this._loadPromise = this._loadFromFile()
        .then(() => {
          this._loaded = true;
        })
        .finally(() => {
          this._loadPromise = null;
        });
    }
    await this._loadPromise;
  }

  async _loadFromFile() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      this._needsLineBoundary = raw.length > 0 && !raw.endsWith("\n");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (row?.record_type === IDEMPOTENCY_ALIAS_RECORD) {
            if (
              row.schema_version === 1 &&
              typeof row.idempotency_key === "string" &&
              row.idempotency_key.length > 0 &&
              row.idempotency_key.length <= 128 &&
              row.idempotency_key.trim() === row.idempotency_key &&
              this.tickets.has(row.ticket_id) &&
              typeof row.input_digest === "string" &&
              /^[a-f0-9]{64}$/.test(row.input_digest) &&
              !this.byIdempotency.has(row.idempotency_key)
            ) {
              this.byIdempotency.set(row.idempotency_key, row.ticket_id);
              this.idempotencyDigests.set(row.idempotency_key, row.input_digest);
            }
            continue;
          }
          if (row?.id) {
            // Derive the duplicate key before publishing a recovered row.
            const dupKey = duplicateTicketKey(row);
            this.tickets.set(row.id, row);
            if (row.idempotency_key) {
              this.byIdempotency.set(row.idempotency_key, row.id);
              this.idempotencyDigests.delete(row.idempotency_key);
            }
            // A restart must preserve, not renew, the original duplicate window.
            this.duplicates.set(dupKey, {
              id: row.id,
              at: row.created_at,
            });
          }
        } catch {
          // skip corrupt lines
        }
      }
    } catch (err) {
      if (err && err.code !== "ENOENT") throw err;
    }
  }

  async persist(stored) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const record = `${this._needsLineBoundary ? "\n" : ""}${JSON.stringify(stored)}\n`;
    // A failed append may leave partial bytes; the next retry needs its own line.
    this._needsLineBoundary = true;
    await fs.appendFile(this.filePath, record, "utf8");
    this._needsLineBoundary = false;
  }

  async create(input, meta) {
    // Concurrent retries must await the durable outcome of the prior write.
    const pending = this._createQueue.then(async () => {
      await this.ensureLoaded();
      return super.create(input, meta);
    });
    // A failed append must not prevent a later request from retrying storage.
    this._createQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async get(id) {
    await this.ensureLoaded();
    return super.get(id);
  }
}

/** Hash IP / email into a stable rate-limit key without logging the raw value. */
export function clientRateKey({ ip, email }) {
  const material = `${ip || "unknown"}|${(email || "").trim().toLowerCase()}`;
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

let singleton;

export function getSupportTicketStore() {
  if (!singleton) {
    const filePath =
      process.env.SUPPORT_TICKET_STORE_PATH ||
      path.join(process.cwd(), ".data", "support-tickets.jsonl");
    singleton = new FileSupportTicketStore(filePath);
  }
  return singleton;
}

export function resetSupportTicketStoreForTests(store) {
  singleton = store || null;
}
