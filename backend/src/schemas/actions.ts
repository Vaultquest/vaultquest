import { z } from "zod";
import { ACTION_TYPES, ACTION_STATUSES } from "../constants.js";

export const walletSchema = z.string().min(1).max(120);
export const idempotencyKeySchema = z.string().uuid();

/**
 * Versioned, asset-aware deposit payload (issue #94). `amount_minor` is the
 * exact integer amount in the asset's smallest unit, carried as a decimal
 * string so it survives JSON transport without floating-point coercion.
 * `asset_code`/`asset_issuer`/`decimals` pin down asset identity so the
 * amount can never be aggregated as if it were a different asset.
 */
export const depositPayloadV1Schema = z.object({
  payload_version: z.literal(1),
  asset_code: z.string().min(1).max(12),
  /** Stellar issuer account id, or "native" for XLM. */
  asset_issuer: z.union([z.literal("native"), z.string().regex(/^G[A-Z0-9]{55}$/)]),
  decimals: z.number().int().min(0).max(7),
  /** Integer minor-unit amount as a decimal string, e.g. "1000000" (no sign, no separators). */
  amount_minor: z.string().regex(/^\d{1,30}$/, "amount_minor must be a non-negative integer string")
});

/**
 * NOTE (issue #94): `action_payload` intentionally stays a permissive
 * record here - the action-ledger write path also carries non-monetary
 * actions (withdraw/create_vault/claim/select_winner) and pre-existing
 * deposit flows whose payload shape is out of this fix's scope. Enforcement
 * for money-safety lives where the bug actually is: QuestService only
 * aggregates deposit rows whose payload validates against
 * {@link depositPayloadV1Schema} (asset identity + exact integer minor
 * units); anything else is quarantined out of fiat-target quest math rather
 * than trusted. See questService.ts.
 */
export const createActionBody = z.object({
  wallet_address: walletSchema,
  action_type: z.enum(ACTION_TYPES),
  // Validated separately against the versioned, size-bounded per-type schemas
  // in actionPayloads.ts so failures produce structured issues (#109).
  action_payload: z.unknown()
});

export const attachTxBody = z.object({
  tx_hash: z.string().min(4).max(200)
});

export const cancelBody = z.object({
  error_code: z.string().min(1).max(64),
  error_detail: z.string().max(1000).optional()
});

export const listQuery = z.object({
  wallet: walletSchema,
  status: z.enum(ACTION_STATUSES).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25)
});

export const reconcileBody = z.object({
  tx_hash: z.string().min(4).max(200),
  soroban_event_id: z.string().min(1).max(200),
  // Validated separately against the versioned event schemas (#109).
  event_payload: z.unknown(),
  status_hint: z.enum(["confirmed", "reverted"])
});

export const dashboardQuery = z.object({
  wallet: walletSchema,
  stale_after_ms: z.coerce.number().int().min(0).max(24 * 60 * 60 * 1000).optional()
});

export const stellarWalletAddressSchema = z.string().regex(/^G[A-Z0-9]{55}$/, "Invalid Stellar wallet address");

export const portfolioQuery = z.object({
  wallet: stellarWalletAddressSchema,
  stale_after_ms: z.coerce.number().int().min(0).max(24 * 60 * 60 * 1000).optional()
});

export const checkpointBody = z.object({
  latest_ledger: z.number().int().nonnegative(),
  last_processed_event_id: z.string().min(1).max(200).nullable().optional(),
  last_error: z.string().nullable().optional(),
  success: z.boolean().default(true)
});


export const exportQuery = z.object({
  wallet: walletSchema,
  format: z.enum(["json", "csv"]).default("json"),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500)
});

export const actionHistoryQuery = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  type: z.enum(ACTION_TYPES).optional(),
  status: z.enum(ACTION_STATUSES).optional(),
});
