/**
 * Support ticket contracts for durable submission (#117).
 *
 * The widget used to fake success after a timeout. These helpers validate
 * payloads, mint receipt IDs, and classify store/API outcomes so the UI only
 * clears the draft after durable acceptance.
 */

export const SUPPORT_TICKET_SCHEMA_VERSION = 1;
export const MAX_DESCRIPTION_CHARS = 4000;
export const MAX_NAME_CHARS = 120;
export const MAX_EMAIL_CHARS = 254;
export const ALLOWED_CATEGORIES = Object.freeze([
  "general",
  "wallet",
  "transaction",
  "bug",
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeWalletHint(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  // Stellar G... or EVM 0x... — context only, never treated as auth.
  if (/^G[A-Z0-9]{55}$/.test(trimmed)) return trimmed;
  if (/^0x[a-fA-F0-9]{40}$/.test(trimmed)) return trimmed.toLowerCase();
  return "";
}

/**
 * @param {object} input
 * @returns {{ ok: true, ticket: object } | { ok: false, code: string, message: string, fieldErrors?: Record<string,string> }}
 */
export function validateTicketInput(input) {
  const fieldErrors = {};
  if (!input || typeof input !== "object") {
    return { ok: false, code: "INVALID_PAYLOAD", message: "ticket payload is required" };
  }

  const name = typeof input.name === "string" ? input.name.trim() : "";
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const category = typeof input.category === "string" ? input.category.trim() : "general";
  const description = typeof input.description === "string" ? input.description.trim() : "";
  const walletHint = normalizeWalletHint(input.wallet_address ?? input.walletAddress);
  const idempotencyKey =
    typeof input.idempotency_key === "string" ? input.idempotency_key.trim().slice(0, 128) : "";

  if (!name) fieldErrors.name = "Name is required";
  else if (name.length > MAX_NAME_CHARS) fieldErrors.name = `Name must be at most ${MAX_NAME_CHARS} characters`;

  if (!email) fieldErrors.email = "Email is required";
  else if (email.length > MAX_EMAIL_CHARS || !EMAIL_RE.test(email)) {
    fieldErrors.email = "Invalid email format";
  }

  if (!ALLOWED_CATEGORIES.includes(category)) {
    fieldErrors.category = "Unsupported category";
  }

  if (!description) fieldErrors.description = "Description is required";
  else if (description.length > MAX_DESCRIPTION_CHARS) {
    fieldErrors.description = `Description must be at most ${MAX_DESCRIPTION_CHARS} characters`;
  }

  if (Object.keys(fieldErrors).length > 0) {
    return {
      ok: false,
      code: "INVALID_PAYLOAD",
      message: "ticket fields failed validation",
      fieldErrors,
    };
  }

  return {
    ok: true,
    ticket: {
      schema_version: SUPPORT_TICKET_SCHEMA_VERSION,
      name,
      email,
      category,
      description,
      wallet_address: walletHint || null,
      idempotency_key: idempotencyKey || null,
    },
  };
}

/**
 * Mint a human-readable receipt id (not a secret).
 * @param {{ now?: () => number, random?: () => number }} [clock]
 */
export function mintReceiptId(clock = {}) {
  const now = typeof clock.now === "function" ? clock.now() : Date.now();
  const rand =
    typeof clock.random === "function" ? clock.random() : Math.random();
  const stamp = new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = Math.floor(rand * 36 ** 6)
    .toString(36)
    .toUpperCase()
    .padStart(6, "0");
  return `VQ-${stamp}-${suffix}`;
}

/**
 * Stable normalized identity for duplicate detection within a rate window.
 * @param {{ email: string, description: string, category: string }} ticket
 */
export function duplicateFingerprint(ticket) {
  const normalized = [
    ticket.email.toLowerCase(),
    ticket.category,
    ticket.description.replace(/\s+/g, " ").trim().toLowerCase(),
  ];
  // A short checksum can alias distinct tickets and silently discard one.
  // Validation bounds this internal key; it is neither persisted nor sent.
  return `dup:${JSON.stringify(normalized)}`;
}
