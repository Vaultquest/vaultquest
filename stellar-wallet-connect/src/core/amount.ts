/**
 * Exact decimal handling for Stellar/Horizon asset amounts (issue #106).
 *
 * Horizon already serialises balances as exact decimal strings with at most
 * 7 fractional digits. Converting them through `Number(...)` throws that
 * exactness away - large values and sub-cent fractions can silently lose
 * precision before a funding/UI decision is made. Everything here stays in
 * either the original decimal string or an exact integer "minor unit"
 * (10^-7, a stroop) so no financial comparison ever touches IEEE-754.
 */

/** Stellar amounts always carry at most 7 fractional digits. */
export const STELLAR_DECIMALS = 7;

/**
 * A validated, asset-identified exact amount. `decimal` is the canonical
 * decimal-string representation (never scientific notation); `minorUnits`
 * is the same value as an exact integer string of 10^-decimals units, safe
 * to compare/sum with BigInt.
 */
export interface AssetAmount {
  assetCode: string;
  /** Issuer account id, or "native" for XLM. */
  assetIssuer: string;
  decimals: number;
  decimal: string;
  minorUnits: string;
}

const AMOUNT_PATTERN = /^(\d+)(?:\.(\d+))?$/;

/**
 * Parses a Horizon-style decimal amount string into exact integer minor
 * units. Returns null for anything that isn't a plain, non-negative decimal
 * with at most `decimals` fractional digits (e.g. scientific notation,
 * signs, sub-stroop precision beyond what the asset supports) - callers
 * must not guess a value for an amount that fails to parse.
 */
export function parseAssetAmount(raw: string, decimals: number = STELLAR_DECIMALS): { minorUnits: bigint; decimal: string } | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const match = AMOUNT_PATTERN.exec(trimmed);
  if (!match) return null;

  const whole = match[1] ?? "0";
  const frac = match[2] ?? "";
  if (frac.length > decimals) return null; // sub-stroop precision: reject, never truncate silently

  const scale = 10n ** BigInt(decimals);
  const fracPadded = frac.padEnd(decimals, "0");
  const minorUnits = BigInt(whole) * scale + (fracPadded ? BigInt(fracPadded) : 0n);

  return { minorUnits, decimal: trimmed };
}

/** Builds a zero AssetAmount for an asset that has no balance line at all. */
export function zeroAssetAmount(assetCode: string, assetIssuer: string, decimals: number = STELLAR_DECIMALS): AssetAmount {
  return { assetCode, assetIssuer, decimals, decimal: "0", minorUnits: "0" };
}

/**
 * Builds an AssetAmount from a raw Horizon balance string. Returns null if
 * the raw value doesn't parse as a valid amount for this asset's precision
 * (callers should treat that as an operational/data problem, not a zero
 * balance).
 */
export function assetAmountFrom(
  assetCode: string,
  assetIssuer: string,
  raw: string,
  decimals: number = STELLAR_DECIMALS
): AssetAmount | null {
  const parsed = parseAssetAmount(raw, decimals);
  if (!parsed) return null;
  return { assetCode, assetIssuer, decimals, decimal: parsed.decimal, minorUnits: parsed.minorUnits.toString() };
}

/**
 * Exact comparison helper - never coerce to Number for this. Returns
 * negative/zero/positive like a standard comparator.
 */
export function compareAssetAmounts(a: AssetAmount, b: AssetAmount): number {
  const av = BigInt(a.minorUnits);
  const bv = BigInt(b.minorUnits);
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}
