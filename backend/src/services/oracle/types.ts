/**
 * Manipulation-resistant pricing (#71).
 *
 * The vault mints shares on deposit, pays assets on withdrawal, and values its
 * book from asset prices. A single stale or manipulated quote can mint excess
 * shares, underpay withdrawals, or hide insolvency. This subsystem stands
 * between raw price feeds and any value-changing operation and refuses to let a
 * single source, a stale reading, or a divergent reading silently move value.
 *
 * Prices are integers scaled by `decimals` (never floats), because share math
 * is exact integer arithmetic and a rounding drift is real money.
 *
 * This module defines adapters and test doubles only. Choosing production feed
 * vendors is explicitly out of scope (#71 non-goals).
 */

/**
 * Fully-qualified asset identity. Every field is compared exactly when matching
 * an observation to a request, which is what prevents cross-network,
 * wrong-asset, and decimal-confusion errors from executing silently.
 */
export interface AssetId {
  /** Human symbol, e.g. "USDC". Informational; never the sole match key. */
  symbol: string;
  /** Contract / issuer address the price is denominated against. */
  contract: string;
  /** Network passphrase or chain id. A mainnet quote must never price a testnet asset. */
  network: string;
}

/** A single reading from one independent source. */
export interface PriceObservation {
  /** Stable id of the source that produced this reading. */
  sourceId: string;
  asset: AssetId;
  /** Price as an integer scaled by `decimals`. */
  price: bigint;
  /** Number of fractional digits encoded in `price`. */
  decimals: number;
  /** Source-reported observation time, ms since epoch. */
  observedAt: number;
  /** Source confidence in [0, 1]. Below the configured floor the reading is dropped. */
  confidence: number;
  /** The source's own round identifier for this reading. */
  roundId: string;
}

/** Why an observation was excluded from an aggregation. */
export type RejectionReason =
  | "WRONG_ASSET"
  | "CROSS_NETWORK"
  | "DECIMAL_CONFUSION"
  | "STALE"
  | "LOW_CONFIDENCE"
  | "NON_POSITIVE_PRICE"
  | "EXTREME_PRICE"
  | "DEVIATION_OUTLIER";

export interface RejectedObservation {
  sourceId: string;
  reason: RejectionReason;
  /** Human detail for logs/alerts. */
  detail?: string;
}

/** Outcome classes for an aggregation attempt. */
export type AggregationStatus =
  /** A quorum of fresh, agreeing sources produced a price. */
  | "OK"
  /** A price was produced, but at least one included source diverged beyond threshold. */
  | "DEGRADED_DEVIATION"
  /** Too few sources survived filtering; no price can be trusted. */
  | "QUORUM_LOSS"
  /** No usable observations at all (all stale / wrong asset / etc.). */
  | "NO_DATA";

/**
 * The immutable result of aggregating sources at one instant. Every mint, burn,
 * and settlement binds itself to one of these by `roundId`, and the full input
 * set is retained so the calculation is reproducible.
 */
export interface AggregatedPrice {
  asset: AssetId;
  /** Median price, normalised to `decimals`. Null when no trusted price exists. */
  price: bigint | null;
  /** Canonical scale of `price`. */
  decimals: number;
  /** Aggregate round id, unique per aggregation. */
  roundId: string;
  /** When the aggregation ran, ms since epoch. */
  asOf: number;
  /** Oldest observation time among contributing sources — the true freshness of the price. */
  observationTime: number;
  status: AggregationStatus;
  /** Source ids that contributed to the median. */
  contributingSources: string[];
  /** Observations that were dropped, with reasons. */
  rejected: RejectedObservation[];
  /** Worst included deviation from the median, in basis points. */
  maxDeviationBps: number;
}

export interface AggregationConfig {
  /** Max age of an observation, ms. Older readings are STALE. */
  maxStalenessMs: number;
  /** Minimum source confidence in [0, 1]. */
  minConfidence: number;
  /** Quorum: minimum trusted sources required to produce a price. */
  minSources: number;
  /** Max allowed deviation of an included source from the median, basis points. */
  maxDeviationBps: number;
  /** Canonical scale all prices are normalised to. */
  targetDecimals: number;
  /** Reject prices at or below this (guards zero / negative). Scaled to targetDecimals. */
  minPrice: bigint;
  /** Reject prices at or above this (guards absurd spikes). Scaled to targetDecimals. */
  maxPrice: bigint;
}

export const DEFAULT_AGGREGATION_CONFIG: AggregationConfig = {
  maxStalenessMs: 60_000,
  minConfidence: 0.5,
  minSources: 3,
  maxDeviationBps: 500, // 5%
  targetDecimals: 18,
  minPrice: 1n,
  maxPrice: 10n ** 30n,
};

/** An adapter wraps one external feed behind a uniform interface. */
export interface OracleAdapter {
  readonly sourceId: string;
  /**
   * Fetch the latest reading for an asset, or null when the source has nothing
   * fresh. Implementations must not throw for a missing price; a thrown error is
   * treated as a hard source failure by the caller.
   */
  fetch(asset: AssetId): Promise<PriceObservation | null>;
}
