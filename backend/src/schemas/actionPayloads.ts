/**
 * Versioned, size-bounded action/event payload schemas (#109).
 *
 * Replaces the previous `z.record(z.unknown())` payloads with strict,
 * discriminated schemas per action/event type. Every payload stored in the
 * ledger carries a `schema_version` so consumers can switch on
 * type + version, and legacy (unversioned) payloads from older producers are
 * migrated on write; payloads that cannot be migrated are quarantined
 * (rejected with a structured error).
 *
 * Design rules:
 *  - Financial fields (`amount`) are exact-unit decimal *strings* — never
 *    JSON floats — with a bounded number of decimal places.
 *  - Asset identity (`token`) is required for financial actions.
 *  - Unknown fields, unknown versions, and oversized payloads fail with
 *    structured errors (zod issues).
 */

import { z, type ZodIssue, type ZodType } from "zod";
import type { ActionType } from "../constants.js";
import { stellarWalletAddressSchema } from "./actions.js";

// ─── Versions ─────────────────────────────────────────────────────────────────

export const ACTION_SCHEMA_VERSION = 1 as const;
export type ActionSchemaVersion = typeof ACTION_SCHEMA_VERSION;

export const EVENT_SCHEMA_VERSION = 1 as const;
export const EVENT_TYPES = ["deposit", "withdraw"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

// ─── Size bounds ──────────────────────────────────────────────────────────────

/**
 * Global bounds applied to the *raw* payload before any versioned parsing, so
 * oversized or deeply-nested objects are rejected before they reach the
 * versioned schemas (which are strict about shape but not about size).
 */
export const PAYLOAD_LIMITS = {
  /** Total serialized size in UTF-8 bytes. */
  maxSerializedBytes: 16 * 1024,
  /** Maximum object/array nesting depth (top-level payload counts as level 1). */
  maxDepth: 6,
  /** Maximum number of keys on any single object. */
  maxKeys: 32,
  /** Maximum length of any string value. */
  maxStringLength: 200,
  /** Maximum number of items in any array. */
  maxArrayItems: 32
} as const;

// ─── Shared primitives ────────────────────────────────────────────────────────

const vaultIdSchema = z.string().min(1).max(120);

/** Asset identity: an asset code of 2–12 alphanumerics (e.g. USDC, XLM, yXLM). */
const assetIdSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9]{1,11}$/, "token must be an asset code (2-12 alphanumeric characters)")
  .max(12);

/**
 * Exact-units amount: a non-negative decimal *string* with at most 7 decimal
 * places. Amounts are never accepted as JSON numbers in versioned payloads so
 * unit precision is never lost to float representation.
 */
const exactUnitsSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)(\.\d{1,7})?$/, "amount must be exact units as a decimal string, e.g. \"1000000\" or \"0.1\"")
  .max(38);

// ─── Versioned action payloads (v1, one strict schema per type) ───────────────

const depositPayloadV1 = z
  .object({
    schema_version: z.literal(ACTION_SCHEMA_VERSION),
    vault_id: vaultIdSchema,
    amount: exactUnitsSchema,
    token: assetIdSchema
  })
  .strict();

/** Withdrawals and claims carry the same financial fields as deposits. */
const withdrawPayloadV1 = depositPayloadV1;
const claimPayloadV1 = depositPayloadV1;

const createVaultPayloadV1 = z
  .object({
    schema_version: z.literal(ACTION_SCHEMA_VERSION),
    vault_id: vaultIdSchema,
    token: assetIdSchema
  })
  .strict();

const selectWinnerPayloadV1 = z
  .object({
    schema_version: z.literal(ACTION_SCHEMA_VERSION),
    vault_id: vaultIdSchema,
    winner: stellarWalletAddressSchema
  })
  .strict();

export type DepositPayload = z.infer<typeof depositPayloadV1>;
export type WithdrawPayload = z.infer<typeof withdrawPayloadV1>;
export type ClaimPayload = z.infer<typeof claimPayloadV1>;
export type CreateVaultPayload = z.infer<typeof createVaultPayloadV1>;
export type SelectWinnerPayload = z.infer<typeof selectWinnerPayloadV1>;

export type VersionedActionPayload =
  | DepositPayload
  | WithdrawPayload
  | ClaimPayload
  | CreateVaultPayload
  | SelectWinnerPayload;

export const ACTION_PAYLOAD_SCHEMAS: Record<ActionType, ZodType<VersionedActionPayload>> = {
  deposit: depositPayloadV1,
  withdraw: withdrawPayloadV1,
  claim: claimPayloadV1,
  create_vault: createVaultPayloadV1,
  select_winner: selectWinnerPayloadV1
};

// ─── Versioned event payloads (v1, discriminated on event_type) ───────────────

const depositEventPayloadV1 = z
  .object({
    schema_version: z.literal(EVENT_SCHEMA_VERSION),
    event_type: z.literal("deposit"),
    vault_id: vaultIdSchema,
    amount: exactUnitsSchema,
    token: assetIdSchema.optional(),
    from: stellarWalletAddressSchema.optional()
  })
  .strict();

const withdrawEventPayloadV1 = z
  .object({
    schema_version: z.literal(EVENT_SCHEMA_VERSION),
    event_type: z.literal("withdraw"),
    vault_id: vaultIdSchema,
    amount: exactUnitsSchema,
    token: assetIdSchema.optional(),
    from: stellarWalletAddressSchema.optional()
  })
  .strict();

export type DepositEventPayload = z.infer<typeof depositEventPayloadV1>;
export type WithdrawEventPayload = z.infer<typeof withdrawEventPayloadV1>;
export type VersionedEventPayload = DepositEventPayload | WithdrawEventPayload;

const EVENT_PAYLOAD_SCHEMAS: Record<EventType, ZodType<VersionedEventPayload>> = {
  deposit: depositEventPayloadV1,
  withdraw: withdrawEventPayloadV1
};

function getEventSchema(eventType: string): ZodType<VersionedEventPayload> | undefined {
  if (eventType === "deposit" || eventType === "withdraw") {
    return EVENT_PAYLOAD_SCHEMAS[eventType];
  }
  return undefined;
}

// ─── Size-bound checks ────────────────────────────────────────────────────────

const MAX_ISSUES = 5;

function customIssue(message: string, path: (string | number)[] = []): ZodIssue {
  return { code: "custom", message, path };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function walkBounds(value: unknown, depth: number, issues: ZodIssue[]): void {
  if (issues.length >= MAX_ISSUES) return;
  if (value === null || typeof value === "boolean") return;

  if (typeof value === "string") {
    if (value.length > PAYLOAD_LIMITS.maxStringLength) {
      issues.push(customIssue(`string value exceeds ${PAYLOAD_LIMITS.maxStringLength} characters`));
    }
    return;
  }

  if (typeof value === "number") return;

  if (Array.isArray(value)) {
    if (value.length > PAYLOAD_LIMITS.maxArrayItems) {
      issues.push(customIssue(`array exceeds ${PAYLOAD_LIMITS.maxArrayItems} items`));
    }
    if (depth + 1 > PAYLOAD_LIMITS.maxDepth) {
      issues.push(customIssue(`payload nesting exceeds ${PAYLOAD_LIMITS.maxDepth} levels`));
      return;
    }
    for (const item of value) walkBounds(item, depth + 1, issues);
    return;
  }

  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length > PAYLOAD_LIMITS.maxKeys) {
      issues.push(customIssue(`object exceeds ${PAYLOAD_LIMITS.maxKeys} keys`));
    }
    if (depth + 1 > PAYLOAD_LIMITS.maxDepth) {
      issues.push(customIssue(`payload nesting exceeds ${PAYLOAD_LIMITS.maxDepth} levels`));
      return;
    }
    for (const key of keys) {
      walkBounds((value as Record<string, unknown>)[key], depth + 1, issues);
    }
  }
}

function checkBounds(raw: unknown): ZodIssue[] {
  const issues: ZodIssue[] = [];
  let size = 0;
  try {
    size = Buffer.byteLength(JSON.stringify(raw), "utf8");
  } catch {
    issues.push(customIssue("payload is not JSON-serializable"));
    return issues;
  }
  if (size > PAYLOAD_LIMITS.maxSerializedBytes) {
    issues.push(
      customIssue(`payload serializes to ${size} bytes, exceeding the ${PAYLOAD_LIMITS.maxSerializedBytes}-byte limit`)
    );
  }
  walkBounds(raw, 1, issues);
  return issues.slice(0, MAX_ISSUES);
}

// ─── Legacy migration helpers ─────────────────────────────────────────────────

/** Coerces legacy numeric/string amounts into exact-unit decimal strings. */
function coerceAmount(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

type MigrationResult<P> =
  | { ok: true; payload: P }
  | { ok: false; issues: ZodIssue[] };

/**
 * Migrates an unversioned (legacy) action payload into the v1 shape for its
 * action type: renames legacy keys (`asset` → `token`, `pool_id` → `vault_id`),
 * coerces numeric amounts to strings, and stamps `schema_version`. Any
 * unknown fields are dropped; if the migrated payload still fails the strict
 * v1 schema (e.g. missing required financial fields), the payload is
 * quarantined (callers reject it with the returned issues).
 */
function migrateLegacyActionPayload(
  actionType: ActionType,
  raw: Record<string, unknown>
): MigrationResult<VersionedActionPayload> {
  const candidate: Record<string, unknown> = {
    schema_version: ACTION_SCHEMA_VERSION,
    vault_id: raw["vault_id"] ?? raw["pool_id"]
  };

  switch (actionType) {
    case "deposit":
    case "withdraw":
    case "claim":
      candidate["amount"] = coerceAmount(raw["amount"]);
      candidate["token"] = raw["token"] ?? raw["asset"] ?? "USDC";
      break;
    case "create_vault":
      candidate["token"] = raw["token"] ?? raw["asset"];
      break;
    case "select_winner":
      candidate["winner"] = raw["winner"];
      break;
    default: {
      const exhaustive: never = actionType;
      return { ok: false, issues: [customIssue(`unknown action type ${String(exhaustive)}`)] };
    }
  }

  const parsed = ACTION_PAYLOAD_SCHEMAS[actionType].safeParse(candidate);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues };
  return { ok: true, payload: parsed.data };
}

function migrateLegacyEventPayload(raw: Record<string, unknown>): MigrationResult<VersionedEventPayload> {
  const eventTypeRaw = raw["event_type"] ?? raw["type"];
  const schema =
    typeof eventTypeRaw === "string" ? getEventSchema(eventTypeRaw) : undefined;
  if (!schema) {
    return {
      ok: false,
      issues: [customIssue(`unsupported event type ${String(eventTypeRaw)}; expected ${EVENT_TYPES.join(" | ")}`)]
    };
  }

  const candidate: Record<string, unknown> = {
    schema_version: EVENT_SCHEMA_VERSION,
    event_type: eventTypeRaw,
    vault_id: raw["vault_id"] ?? raw["pool_id"],
    amount: coerceAmount(raw["amount"])
  };
  const token = raw["token"] ?? raw["asset"];
  if (token !== undefined) candidate["token"] = token;
  if (raw["from"] !== undefined) candidate["from"] = raw["from"];

  const parsed = schema.safeParse(candidate);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues };
  return { ok: true, payload: parsed.data };
}

// ─── Public parse entry points ────────────────────────────────────────────────

export type PayloadParseResult =
  | { ok: true; payload: VersionedActionPayload }
  | { ok: false; issues: ZodIssue[]; quarantined: boolean };

/**
 * Parses an action payload for a given action type. Applies the global size
 * bounds, then either:
 *  - parses a versioned payload strictly (unknown fields/versions fail), or
 *  - migrates a legacy (unversioned) payload, quarantining it on failure.
 */
export function parseActionPayload(actionType: ActionType, raw: unknown): PayloadParseResult {
  const bounds = checkBounds(raw);
  if (bounds.length > 0) {
    return { ok: false, issues: bounds, quarantined: false };
  }
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      issues: [customIssue("action_payload must be a JSON object")],
      quarantined: false
    };
  }

  const version = raw["schema_version"];
  if (version === undefined) {
    const migrated = migrateLegacyActionPayload(actionType, raw);
    if (!migrated.ok) return { ok: false, issues: migrated.issues, quarantined: true };
    return { ok: true, payload: migrated.payload };
  }

  if (version !== ACTION_SCHEMA_VERSION) {
    return {
      ok: false,
      issues: [
        customIssue(
          `unsupported schema_version ${String(version)}; expected ${ACTION_SCHEMA_VERSION}`,
          ["schema_version"]
        )
      ],
      quarantined: false
    };
  }

  const parsed = ACTION_PAYLOAD_SCHEMAS[actionType].safeParse(raw);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues, quarantined: false };
  return { ok: true, payload: parsed.data };
}

export type EventParseResult =
  | { ok: true; payload: VersionedEventPayload }
  | { ok: false; issues: ZodIssue[]; quarantined: boolean };

/** Parses a reconciliation event payload with the same versioning rules. */
export function parseEventPayload(raw: unknown): EventParseResult {
  const bounds = checkBounds(raw);
  if (bounds.length > 0) {
    return { ok: false, issues: bounds, quarantined: false };
  }
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      issues: [customIssue("event_payload must be a JSON object")],
      quarantined: false
    };
  }

  const version = raw["schema_version"];
  if (version === undefined) {
    const migrated = migrateLegacyEventPayload(raw);
    if (!migrated.ok) return { ok: false, issues: migrated.issues, quarantined: true };
    return { ok: true, payload: migrated.payload };
  }

  if (version !== EVENT_SCHEMA_VERSION) {
    return {
      ok: false,
      issues: [
        customIssue(
          `unsupported schema_version ${String(version)}; expected ${EVENT_SCHEMA_VERSION}`,
          ["schema_version"]
        )
      ],
      quarantined: false
    };
  }

  const eventTypeRaw = raw["event_type"];
  const schema = typeof eventTypeRaw === "string" ? getEventSchema(eventTypeRaw) : undefined;
  if (!schema) {
    return {
      ok: false,
      issues: [
        customIssue(
          `unsupported event_type ${String(eventTypeRaw)}; expected ${EVENT_TYPES.join(" | ")}`,
          ["event_type"]
        )
      ],
      quarantined: false
    };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues, quarantined: false };
  return { ok: true, payload: parsed.data };
}

// ─── Read-side view ───────────────────────────────────────────────────────────

export type ActionPayloadView = {
  vaultId: string;
  amount: string;
  token: string;
};

/**
 * Read-side extraction used by consumers (portfolio rollups, CSV export).
 * Tolerant of both versioned and legacy stored payloads, switching
 * exhaustively on the action type so per-type fields are explicit.
 */
export function toActionPayloadView(actionType: ActionType, payload: unknown): ActionPayloadView | null {
  if (!isPlainObject(payload)) return null;

  const vaultId =
    typeof payload["vault_id"] === "string"
      ? payload["vault_id"]
      : typeof payload["pool_id"] === "string"
        ? payload["pool_id"]
        : "";
  const token =
    typeof payload["token"] === "string"
      ? payload["token"]
      : typeof payload["asset"] === "string"
        ? payload["asset"]
        : "USDC";
  const amount = coerceAmount(payload["amount"]) ?? "0";

  switch (actionType) {
    case "deposit":
    case "withdraw":
    case "claim":
      return { vaultId, amount, token };
    case "create_vault":
      return { vaultId, amount: "0", token };
    case "select_winner":
      return { vaultId, amount: "0", token };
    default: {
      const exhaustive: never = actionType;
      void exhaustive;
      return null;
    }
  }
}
