import type {
  AggregatedPrice,
  AggregationConfig,
  AssetId,
  PriceObservation,
  RejectedObservation,
} from "./types.js";

/** True when two asset identities refer to the same thing on the same network. */
export function assetEquals(a: AssetId, b: AssetId): boolean {
  return a.symbol === b.symbol && a.contract === b.contract && a.network === b.network;
}

/**
 * Rescale an integer price from `fromDecimals` to `toDecimals` without losing
 * value. Scaling *up* is always exact. Scaling *down* is only allowed when the
 * value divides evenly; otherwise the reading carries more precision than the
 * canonical scale and silently truncating it is exactly the decimal-confusion
 * bug this guards against, so it returns null and the caller rejects the source.
 */
export function normalizeDecimals(price: bigint, fromDecimals: number, toDecimals: number): bigint | null {
  if (fromDecimals === toDecimals) return price;
  if (toDecimals > fromDecimals) {
    return price * 10n ** BigInt(toDecimals - fromDecimals);
  }
  const divisor = 10n ** BigInt(fromDecimals - toDecimals);
  if (price % divisor !== 0n) return null;
  return price / divisor;
}

/** Median of a non-empty sorted-or-unsorted bigint list. Even counts average the two middles. */
export function median(values: bigint[]): bigint {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2n;
}

/** Absolute deviation of `value` from `reference`, in basis points. */
export function deviationBps(value: bigint, reference: bigint): number {
  if (reference === 0n) return Number.POSITIVE_INFINITY;
  const diff = value > reference ? value - reference : reference - value;
  // bps = diff / reference * 10000, computed in bigint then narrowed.
  return Number((diff * 10_000n) / (reference < 0n ? -reference : reference));
}

interface Candidate {
  observation: PriceObservation;
  /** Price normalised to targetDecimals. */
  price: bigint;
}

let roundCounter = 0;

/** Monotonic-ish unique aggregate round id. Kept internal so callers can't collide ids. */
export function nextRoundId(asOf: number): string {
  roundCounter += 1;
  return `agg-${asOf}-${roundCounter}`;
}

/**
 * Aggregate independent observations into one trusted price under a documented
 * median/quorum rule.
 *
 * Pipeline, in order, each stage recording why a source dropped out:
 *  1. asset identity — wrong asset or wrong network is excluded, never priced.
 *  2. decimal normalisation — a reading that cannot be represented at the
 *     canonical scale without loss is excluded (decimal confusion).
 *  3. sanity bounds — non-positive and absurd prices are excluded.
 *  4. freshness — observations older than the window are excluded.
 *  5. confidence — low-confidence readings are excluded.
 *  6. quorum — fewer than `minSources` survivors yields no price.
 *  7. robust median — the median of survivors is the reference; survivors that
 *     deviate beyond threshold are dropped as outliers, then quorum is
 *     re-checked and the final median is taken over the inliers. One wild or
 *     malicious source cannot move a median backed by a quorum, and if enough
 *     sources diverge that quorum breaks, the result is QUORUM_LOSS rather than
 *     a silently wrong price.
 */
export function aggregate(
  asset: AssetId,
  observations: PriceObservation[],
  config: AggregationConfig,
  now: number,
): AggregatedPrice {
  const rejected: RejectedObservation[] = [];
  const candidates: Candidate[] = [];

  for (const obs of observations) {
    if (obs.asset.network !== asset.network) {
      rejected.push({ sourceId: obs.sourceId, reason: "CROSS_NETWORK", detail: obs.asset.network });
      continue;
    }
    if (!assetEquals(obs.asset, asset)) {
      rejected.push({ sourceId: obs.sourceId, reason: "WRONG_ASSET", detail: obs.asset.symbol });
      continue;
    }

    const normalized = normalizeDecimals(obs.price, obs.decimals, config.targetDecimals);
    if (normalized === null) {
      rejected.push({
        sourceId: obs.sourceId,
        reason: "DECIMAL_CONFUSION",
        detail: `${obs.decimals}->${config.targetDecimals}`,
      });
      continue;
    }

    if (normalized <= 0n || normalized < config.minPrice) {
      rejected.push({ sourceId: obs.sourceId, reason: "NON_POSITIVE_PRICE", detail: normalized.toString() });
      continue;
    }
    if (normalized >= config.maxPrice) {
      rejected.push({ sourceId: obs.sourceId, reason: "EXTREME_PRICE", detail: normalized.toString() });
      continue;
    }

    if (now - obs.observedAt > config.maxStalenessMs) {
      rejected.push({ sourceId: obs.sourceId, reason: "STALE", detail: `${now - obs.observedAt}ms` });
      continue;
    }

    if (obs.confidence < config.minConfidence) {
      rejected.push({ sourceId: obs.sourceId, reason: "LOW_CONFIDENCE", detail: obs.confidence.toString() });
      continue;
    }

    candidates.push({ observation: obs, price: normalized });
  }

  const roundId = nextRoundId(now);
  const base = {
    asset,
    decimals: config.targetDecimals,
    roundId,
    asOf: now,
    rejected,
  };

  if (candidates.length === 0) {
    return {
      ...base,
      price: null,
      status: "NO_DATA",
      observationTime: now,
      contributingSources: [],
      maxDeviationBps: 0,
    };
  }

  if (candidates.length < config.minSources) {
    return {
      ...base,
      price: null,
      status: "QUORUM_LOSS",
      observationTime: oldest(candidates),
      contributingSources: candidates.map((c) => c.observation.sourceId),
      maxDeviationBps: 0,
    };
  }

  // Robust median: reference over all survivors, then drop outliers.
  const reference = median(candidates.map((c) => c.price));
  const inliers: Candidate[] = [];
  let deviationDropped = false;

  for (const c of candidates) {
    const dev = deviationBps(c.price, reference);
    if (dev > config.maxDeviationBps) {
      rejected.push({ sourceId: c.observation.sourceId, reason: "DEVIATION_OUTLIER", detail: `${dev}bps` });
      deviationDropped = true;
    } else {
      inliers.push(c);
    }
  }

  if (inliers.length < config.minSources) {
    return {
      ...base,
      price: null,
      status: "QUORUM_LOSS",
      observationTime: oldest(candidates),
      contributingSources: inliers.map((c) => c.observation.sourceId),
      maxDeviationBps: worstDeviation(candidates, reference),
    };
  }

  const finalPrice = median(inliers.map((c) => c.price));
  const maxDeviationBps = worstDeviation(inliers, finalPrice);

  return {
    ...base,
    price: finalPrice,
    // A dropped outlier means the raw feed set disagreed: surface it so the
    // breaker can react even though the median itself is trustworthy.
    status: deviationDropped ? "DEGRADED_DEVIATION" : "OK",
    observationTime: oldest(inliers),
    contributingSources: inliers.map((c) => c.observation.sourceId),
    maxDeviationBps,
  };
}

function oldest(candidates: Candidate[]): number {
  return candidates.reduce((min, c) => Math.min(min, c.observation.observedAt), Number.POSITIVE_INFINITY);
}

function worstDeviation(candidates: Candidate[], reference: bigint): number {
  return candidates.reduce((max, c) => Math.max(max, deviationBps(c.price, reference)), 0);
}
