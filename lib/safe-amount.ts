/**
 * Precision-safe vault share math, fee calculations, and rounding preview
 * matching the Soroban drip-pool contract implementation.
 */

export const PPS_SCALE = 1_000_000_000_000n;
export const VIRTUAL_SHARES = 1_000_000n;
export const VIRTUAL_ASSETS = 1n;
export const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n;
export const BPS_DENOMINATOR = 10_000n;
export const VAULT_DATA_STALE_AFTER_MS = 120_000;
export const DEFAULT_ASSET_DECIMALS = 7;

export type VaultMathErrorKind =
  | "InvalidAmount"
  | "RoundsToZero"
  | "StaleSnapshot"
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

export interface RawVaultSnapshot {
  total_shares?: bigint | string | number | null;
  total_assets?: bigint | string | number | null;
  pending_withdrawals?: bigint | string | number | null;
  accrued_fees?: bigint | string | number | null;
  donated_assets?: bigint | string | number | null;
  dust?: bigint | string | number | null;
  high_water_mark?: bigint | string | number | null;
  last_fee_time?: bigint | string | number | null;
  version?: bigint | string | number | null;
  updatedAt?: string | number | Date | null;
  tvl?: bigint | string | number | null;
}

export interface NormalizedVaultSnapshot {
  total_shares: bigint;
  total_assets: bigint;
  pending_withdrawals: bigint;
  accrued_fees: bigint;
  donated_assets: bigint;
  dust: bigint;
  high_water_mark: bigint;
  last_fee_time: bigint;
  version: bigint;
  updatedAt: Date | null;
}

export interface FeeConfig {
  management_fee_bps?: number | bigint | null;
  performance_fee_bps?: number | bigint | null;
}

export interface DepositPreviewInput {
  snapshot: RawVaultSnapshot;
  assets: bigint | string | number;
  decimals?: number;
  feeConfig?: FeeConfig;
  nowSeconds?: number | bigint;
  nowMs?: number;
}

export interface DepositPreviewOutput {
  sharesMinted: bigint;
  sharesMintedFormatted: string;
  pricePerShareBefore: bigint;
  pricePerShareAfter: bigint;
  netAssetsBefore: bigint;
  netAssetsAfter: bigint;
  totalSharesBefore: bigint;
  totalSharesAfter: bigint;
  accruedManagementFee: bigint;
  accruedPerformanceFee: bigint;
  totalAccruedFees: bigint;
  expectedVersion: bigint;
  poolShareBps: bigint;
  isStale: boolean;
}

/**
 * Coerces unknown scalar values into non-negative BigInts safely.
 */
function toBigIntSafe(val: bigint | string | number | null | undefined, fallback = 0n): bigint {
  if (val === null || val === undefined) return fallback;
  if (typeof val === "bigint") return val;
  if (typeof val === "number") {
    if (!Number.isFinite(val)) return fallback;
    return BigInt(Math.trunc(val));
  }
  const trimmed = String(val).trim();
  if (!trimmed) return fallback;
  try {
    return BigInt(trimmed);
  } catch {
    const floatVal = Number.parseFloat(trimmed);
    if (!Number.isFinite(floatVal)) return fallback;
    return BigInt(Math.trunc(floatVal));
  }
}

/**
 * Normalizes loose pool metadata and snapshots into strongly typed BigInt values.
 */
export function normalizeSnapshot(raw: RawVaultSnapshot): NormalizedVaultSnapshot {
  const totalAssets =
    raw.total_assets !== undefined && raw.total_assets !== null
      ? toBigIntSafe(raw.total_assets)
      : toBigIntSafe(raw.tvl);

  let updatedDate: Date | null = null;
  if (raw.updatedAt) {
    const parsed = new Date(raw.updatedAt);
    if (Number.isFinite(parsed.getTime())) {
      updatedDate = parsed;
    }
  }

  const snapshot: NormalizedVaultSnapshot = {
    total_shares: toBigIntSafe(raw.total_shares),
    total_assets: totalAssets,
    pending_withdrawals: toBigIntSafe(raw.pending_withdrawals),
    accrued_fees: toBigIntSafe(raw.accrued_fees),
    donated_assets: toBigIntSafe(raw.donated_assets),
    dust: toBigIntSafe(raw.dust),
    high_water_mark: toBigIntSafe(raw.high_water_mark),
    last_fee_time: toBigIntSafe(raw.last_fee_time),
    version: toBigIntSafe(raw.version),
    updatedAt: updatedDate,
  };

  if (snapshot.high_water_mark === 0n) {
    snapshot.high_water_mark = pricePerShare(snapshot);
  }

  return snapshot;
}

/**
 * Exact floor multiplication-division avoiding precision loss or overflow.
 */
export function mulDivFloor(a: bigint, b: bigint, denom: bigint): bigint {
  if (denom <= 0n) {
    throw new VaultMathError("MathOverflow", "Denominator must be positive");
  }
  return (a * b) / denom;
}

/**
 * Exact ceiling multiplication-division rounding up on non-zero remainder.
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
 * Calculates net assets backing outstanding shares after liabilities.
 */
export function netAssets(snapshot: NormalizedVaultSnapshot): bigint {
  const intermediate = snapshot.total_assets - snapshot.pending_withdrawals;
  const net = intermediate - snapshot.accrued_fees;
  if (net < 0n) {
    throw new VaultMathError("MathOverflow", "Net assets cannot be negative");
  }
  return net;
}

/**
 * Calculates virtual shares incorporating the decimals offset.
 */
export function virtualShares(snapshot: NormalizedVaultSnapshot): bigint {
  return snapshot.total_shares + VIRTUAL_SHARES;
}

/**
 * Calculates virtual assets incorporating the virtual baseline.
 */
export function virtualAssets(snapshot: NormalizedVaultSnapshot): bigint {
  return netAssets(snapshot) + VIRTUAL_ASSETS;
}

/**
 * Evaluates price per share scaled by PPS_SCALE using floor division.
 */
export function pricePerShare(snapshot: NormalizedVaultSnapshot): bigint {
  return mulDivFloor(virtualAssets(snapshot), PPS_SCALE, virtualShares(snapshot));
}

/**
 * Simulates pro-rata management fee accrual over elapsed seconds.
 */
export function accrueManagementFee(
  snapshot: NormalizedVaultSnapshot,
  nowSeconds: bigint,
  annualRateBps: bigint
): { fee: bigint; nextSnapshot: NormalizedVaultSnapshot } {
  if (nowSeconds < snapshot.last_fee_time) {
    throw new VaultMathError("StaleSnapshot", "Timestamp precedes last fee checkpoint");
  }

  const elapsed = nowSeconds - snapshot.last_fee_time;
  const nextSnapshot: NormalizedVaultSnapshot = {
    ...snapshot,
    last_fee_time: nowSeconds,
    version: snapshot.version + 1n,
  };

  if (elapsed === 0n || annualRateBps === 0n) {
    return { fee: 0n, nextSnapshot };
  }

  const rateSeconds = annualRateBps * elapsed;
  const yearBps = BPS_DENOMINATOR * SECONDS_PER_YEAR;
  const currentNet = netAssets(snapshot);
  const fee = mulDivFloor(currentNet, rateSeconds, yearBps);

  nextSnapshot.accrued_fees = nextSnapshot.accrued_fees + fee;
  return { fee, nextSnapshot };
}

/**
 * Simulates performance fee accrual against the high-water mark.
 */
export function accruePerformanceFee(
  snapshot: NormalizedVaultSnapshot,
  performanceFeeBps: bigint
): { fee: bigint; nextSnapshot: NormalizedVaultSnapshot } {
  const nextSnapshot: NormalizedVaultSnapshot = {
    ...snapshot,
    version: snapshot.version + 1n,
  };

  if (performanceFeeBps === 0n) {
    return { fee: 0n, nextSnapshot };
  }

  const currentPps = pricePerShare(snapshot);
  if (currentPps <= snapshot.high_water_mark) {
    return { fee: 0n, nextSnapshot };
  }

  const gainPerShare = currentPps - snapshot.high_water_mark;
  const totalGain = mulDivFloor(gainPerShare, virtualShares(snapshot), PPS_SCALE);
  const fee = mulDivFloor(totalGain, performanceFeeBps, BPS_DENOMINATOR);

  if (fee <= 0n) {
    return { fee: 0n, nextSnapshot };
  }

  nextSnapshot.accrued_fees = nextSnapshot.accrued_fees + fee;
  const postFeePps = pricePerShare(nextSnapshot);
  if (postFeePps > nextSnapshot.high_water_mark) {
    nextSnapshot.high_water_mark = postFeePps;
  }

  return { fee, nextSnapshot };
}

/**
 * Evaluates preview shares minted for an asset deposit according to floor math.
 */
export function previewDeposit(
  rawSnapshot: RawVaultSnapshot | NormalizedVaultSnapshot,
  assetsInput: bigint | string | number
): bigint {
  const snapshot = "updatedAt" in rawSnapshot && typeof rawSnapshot.total_shares === "bigint"
    ? (rawSnapshot as NormalizedVaultSnapshot)
    : normalizeSnapshot(rawSnapshot);

  const assets = toBigIntSafe(assetsInput);
  if (assets <= 0n) {
    throw new VaultMathError("InvalidAmount", "Deposit amount must be positive");
  }

  const shares = mulDivFloor(assets, virtualShares(snapshot), virtualAssets(snapshot));
  if (shares <= 0n) {
    throw new VaultMathError("RoundsToZero", "Deposit amount too small to mint shares");
  }

  return shares;
}

/**
 * Evaluates preview assets owed for redeeming shares according to floor math.
 */
export function previewRedeem(
  rawSnapshot: RawVaultSnapshot | NormalizedVaultSnapshot,
  sharesInput: bigint | string | number
): bigint {
  const snapshot = "updatedAt" in rawSnapshot && typeof rawSnapshot.total_shares === "bigint"
    ? (rawSnapshot as NormalizedVaultSnapshot)
    : normalizeSnapshot(rawSnapshot);

  const shares = toBigIntSafe(sharesInput);
  if (shares <= 0n) {
    throw new VaultMathError("InvalidAmount", "Redeem shares must be positive");
  }
  if (shares > snapshot.total_shares) {
    throw new VaultMathError("InsufficientShares", "Redeem exceeds total shares");
  }

  const assets = mulDivFloor(shares, virtualAssets(snapshot), virtualShares(snapshot));
  if (assets <= 0n) {
    throw new VaultMathError("RoundsToZero", "Redeem amount rounds to zero assets");
  }

  return assets;
}

/**
 * Evaluates preview assets required to mint target shares using ceiling math.
 */
export function previewMint(
  rawSnapshot: RawVaultSnapshot | NormalizedVaultSnapshot,
  sharesInput: bigint | string | number
): bigint {
  const snapshot = "updatedAt" in rawSnapshot && typeof rawSnapshot.total_shares === "bigint"
    ? (rawSnapshot as NormalizedVaultSnapshot)
    : normalizeSnapshot(rawSnapshot);

  const shares = toBigIntSafe(sharesInput);
  if (shares <= 0n) {
    throw new VaultMathError("InvalidAmount", "Mint shares must be positive");
  }

  return mulDivCeil(shares, virtualAssets(snapshot), virtualShares(snapshot));
}

/**
 * Evaluates preview shares burned for an asset withdrawal using ceiling math.
 */
export function previewWithdraw(
  rawSnapshot: RawVaultSnapshot | NormalizedVaultSnapshot,
  assetsInput: bigint | string | number
): bigint {
  const snapshot = "updatedAt" in rawSnapshot && typeof rawSnapshot.total_shares === "bigint"
    ? (rawSnapshot as NormalizedVaultSnapshot)
    : normalizeSnapshot(rawSnapshot);

  const assets = toBigIntSafe(assetsInput);
  if (assets <= 0n) {
    throw new VaultMathError("InvalidAmount", "Withdraw assets must be positive");
  }
  if (assets > netAssets(snapshot)) {
    throw new VaultMathError("InsufficientBalance", "Withdraw exceeds net assets");
  }

  return mulDivCeil(assets, virtualShares(snapshot), virtualAssets(snapshot));
}

/**
 * Checks if a pool snapshot is older than the freshness threshold.
 */
export function isPoolStateStale(
  updatedAt?: string | number | Date | null,
  nowMs: number = Date.now()
): boolean {
  if (!updatedAt) return true;
  const timestamp =
    typeof updatedAt === "number"
      ? updatedAt
      : updatedAt instanceof Date
      ? updatedAt.getTime()
      : Date.parse(updatedAt);

  if (!Number.isFinite(timestamp)) return true;
  return Math.max(0, nowMs - timestamp) >= VAULT_DATA_STALE_AFTER_MS;
}

/**
 * Full deposit preview computing shares, fees, pricing, and pool share impact.
 */
export function previewDepositDetailed(input: DepositPreviewInput): DepositPreviewOutput {
  const initialSnapshot = normalizeSnapshot(input.snapshot);
  const decimals = input.decimals ?? DEFAULT_ASSET_DECIMALS;
  const nowMs = input.nowMs ?? Date.now();
  const nowSeconds = input.nowSeconds !== undefined ? BigInt(input.nowSeconds) : BigInt(Math.floor(nowMs / 1000));

  const mgmtBps = toBigIntSafe(input.feeConfig?.management_fee_bps);
  const perfBps = toBigIntSafe(input.feeConfig?.performance_fee_bps);

  let currentSnapshot = initialSnapshot;
  let accruedMgmt = 0n;
  let accruedPerf = 0n;

  if (nowSeconds >= currentSnapshot.last_fee_time && mgmtBps > 0n) {
    const mgmtRes = accrueManagementFee(currentSnapshot, nowSeconds, mgmtBps);
    accruedMgmt = mgmtRes.fee;
    currentSnapshot = mgmtRes.nextSnapshot;
  }

  if (perfBps > 0n) {
    const perfRes = accruePerformanceFee(currentSnapshot, perfBps);
    accruedPerf = perfRes.fee;
    currentSnapshot = perfRes.nextSnapshot;
  }

  const assets = toBigIntSafe(input.assets);
  const sharesMinted = previewDeposit(currentSnapshot, assets);

  const priceBefore = pricePerShare(currentSnapshot);
  const netAssetsBefore = netAssets(currentSnapshot);

  const postSnapshot: NormalizedVaultSnapshot = {
    ...currentSnapshot,
    total_assets: currentSnapshot.total_assets + assets,
    total_shares: currentSnapshot.total_shares + sharesMinted,
    version: currentSnapshot.version + 1n,
  };

  const priceAfter = pricePerShare(postSnapshot);
  const netAssetsAfter = netAssets(postSnapshot);
  const poolShareBps =
    postSnapshot.total_shares > 0n
      ? (sharesMinted * 10_000n) / postSnapshot.total_shares
      : 10_000n;

  const isStale = isPoolStateStale(input.snapshot.updatedAt, nowMs);

  return {
    sharesMinted,
    sharesMintedFormatted: formatAssetAmount(sharesMinted, decimals),
    pricePerShareBefore: priceBefore,
    pricePerShareAfter: priceAfter,
    netAssetsBefore,
    netAssetsAfter,
    totalSharesBefore: currentSnapshot.total_shares,
    totalSharesAfter: postSnapshot.total_shares,
    accruedManagementFee: accruedMgmt,
    accruedPerformanceFee: accruedPerf,
    totalAccruedFees: accruedMgmt + accruedPerf,
    expectedVersion: postSnapshot.version,
    poolShareBps,
    isStale,
  };
}

const AMOUNT_PATTERN = /^(\d+)(?:\.(\d+))?$/;

/**
 * Converts decimal strings to minor unit BigInt amounts safely without IEEE-754 precision loss.
 */
export function parseAssetAmount(
  raw: string,
  decimals: number = DEFAULT_ASSET_DECIMALS
): { minorUnits: bigint; decimal: string } | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const match = AMOUNT_PATTERN.exec(trimmed);
  if (!match) return null;

  const whole = match[1] ?? "0";
  const frac = match[2] ?? "";
  if (frac.length > decimals) return null;

  const scale = 10n ** BigInt(decimals);
  const fracPadded = frac.padEnd(decimals, "0");
  const minorUnits = BigInt(whole) * scale + (fracPadded ? BigInt(fracPadded) : 0n);

  return { minorUnits, decimal: trimmed };
}

/**
 * Formats minor unit BigInts into localized fixed decimal strings.
 */
export function formatAssetAmount(
  minorUnitsInput: bigint | string | number,
  decimals: number = DEFAULT_ASSET_DECIMALS
): string {
  const minorUnits = toBigIntSafe(minorUnitsInput);
  const scale = 10n ** BigInt(decimals);
  const whole = minorUnits / scale;
  const fraction = minorUnits % scale;

  if (decimals === 0) return whole.toString();
  const fractionStr = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fractionStr.length > 0 ? `${whole}.${fractionStr}` : whole.toString();
}
