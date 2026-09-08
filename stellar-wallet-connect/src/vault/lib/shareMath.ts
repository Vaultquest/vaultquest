/**
 * Soroban contract vault share math and rounding calculations.
 */

export const PPS_SCALE = 1_000_000_000_000n;
export const VIRTUAL_SHARES = 1_000_000n;
export const VIRTUAL_ASSETS = 1n;
export const VAULT_DATA_STALE_AFTER_MS = 120_000;
export const DEFAULT_ASSET_DECIMALS = 7;

export type VaultMathErrorKind =
  | "InvalidAmount"
  | "RoundsToZero"
  | "InsufficientBalance"
  | "InsufficientShares"
  | "MathOverflow";

/**
 * Custom error thrown on contract invariant violations during share calculation.
 */
export class VaultMathError extends Error {
  readonly kind: VaultMathErrorKind;

  constructor(kind: VaultMathErrorKind, message?: string) {
    super(message ?? kind);
    this.name = "VaultMathError";
    this.kind = kind;
  }
}

export interface PoolSnapshotInput {
  tvl?: string | number | bigint | null;
  totalAssets?: string | number | bigint | null;
  totalShares?: string | number | bigint | null;
  pendingWithdrawals?: string | number | bigint | null;
  accruedFees?: string | number | bigint | null;
  updatedAt?: string | number | Date | null;
}

/**
 * Safely parses any number, string, or bigint input into a non-negative BigInt.
 */
function toBigIntSafe(val: unknown, fallback = 0n): bigint {
  if (val === null || val === undefined) return fallback;
  if (typeof val === "bigint") return val;
  if (typeof val === "number") {
    if (!Number.isFinite(val)) return fallback;
    return BigInt(Math.trunc(val));
  }
  const str = String(val).trim();
  if (!str) return fallback;
  try {
    return BigInt(str);
  } catch {
    const floatVal = Number.parseFloat(str);
    if (!Number.isFinite(floatVal)) return fallback;
    return BigInt(Math.trunc(floatVal));
  }
}

/**
 * Floor multiplication-division.
 */
export function mulDivFloor(a: bigint, b: bigint, denom: bigint): bigint {
  if (denom <= 0n) {
    throw new VaultMathError("MathOverflow", "Denominator must be positive");
  }
  return (a * b) / denom;
}

/**
 * Ceiling multiplication-division.
 */
export function mulDivCeil(a: bigint, b: bigint, denom: bigint): bigint {
  if (denom <= 0n) {
    throw new VaultMathError("MathOverflow", "Denominator must be positive");
  }
  const product = a * b;
  const quotient = product / denom;
  const remainder = product % denom;
  return remainder === 0n ? quotient : quotient + 1n;
}

/**
 * Computes preview shares minted for an asset deposit according to contract floor math.
 */
export function computeDepositSharesPreview(
  pool: PoolSnapshotInput,
  depositAssets: bigint
): bigint {
  if (depositAssets <= 0n) {
    throw new VaultMathError("InvalidAmount", "Deposit amount must be positive");
  }

  const rawAssets = pool.totalAssets ?? pool.tvl;
  const totalAssets = toBigIntSafe(rawAssets);
  const pending = toBigIntSafe(pool.pendingWithdrawals);
  const accrued = toBigIntSafe(pool.accruedFees);
  const totalShares = toBigIntSafe(pool.totalShares);

  const net = totalAssets - pending - accrued;
  const netAssets = net > 0n ? net : 0n;

  const vAssets = netAssets + VIRTUAL_ASSETS;
  const vShares = totalShares + VIRTUAL_SHARES;

  const shares = mulDivFloor(depositAssets, vShares, vAssets);
  if (shares <= 0n) {
    throw new VaultMathError("RoundsToZero", "Deposit amount too small to mint shares");
  }

  return shares;
}

/**
 * Checks if a pool state timestamp exceeds the stale threshold.
 */
export function isPoolStateStale(
  updatedAt?: string | number | Date | null,
  nowMs: number = Date.now()
): boolean {
  if (!updatedAt) return false;
  const timestamp =
    typeof updatedAt === "number"
      ? updatedAt
      : updatedAt instanceof Date
      ? updatedAt.getTime()
      : Date.parse(updatedAt);

  if (!Number.isFinite(timestamp)) return false;
  return Math.max(0, nowMs - timestamp) >= VAULT_DATA_STALE_AFTER_MS;
}

/**
 * Formats a raw minor unit BigInt into a human-readable display string.
 */
export function formatShareAmount(
  minorUnits: bigint,
  decimals: number = DEFAULT_ASSET_DECIMALS
): string {
  const scale = 10n ** BigInt(decimals);
  const whole = minorUnits / scale;
  const fraction = minorUnits % scale;
  if (decimals === 0) return whole.toString();
  const fracStr = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr.length > 0 ? `${whole}.${fracStr}` : whole.toString();
}
