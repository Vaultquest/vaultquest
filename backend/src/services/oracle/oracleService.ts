import {
  DEFAULT_AGGREGATION_CONFIG,
  type AggregatedPrice,
  type AggregationConfig,
  type AssetId,
  type OracleAdapter,
  type PriceObservation,
} from "./types.js";
import { aggregate } from "./aggregator.js";
import {
  CircuitBreaker,
  DEFAULT_BREAKER_CONFIG,
  decideOperation,
  type BreakerConfig,
  type BreakerState,
  type OperationDecision,
  type VaultOperation,
} from "./circuitBreaker.js";
import { SnapshotStore, SourceGovernance, type StoredSnapshot } from "./governance.js";
import { NULL_METRICS, type OracleMetricsSink } from "./metrics.js";

export interface OracleServiceOptions {
  adapters: OracleAdapter[];
  /** Timelock for source-set changes, ms. */
  governanceTimelockMs: number;
  aggregationConfig?: Partial<AggregationConfig>;
  breakerConfig?: Partial<BreakerConfig>;
  metrics?: OracleMetricsSink;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  snapshotCapacity?: number;
}

export interface PricingResult {
  price: AggregatedPrice;
  breakerState: BreakerState;
}

/**
 * Orchestrates the pieces into one manipulation-resistant pricing surface:
 * gather observations from the *governed* source set, aggregate under the
 * median/quorum rule, drive the circuit breaker, persist a reproducible
 * snapshot, and gate value-changing operations.
 *
 * The last trustworthy price is remembered so an OPEN breaker can still offer a
 * conservative emergency exit.
 */
export class OracleService {
  private readonly adapters: Map<string, OracleAdapter>;
  private readonly aggregationConfig: AggregationConfig;
  private readonly breakerConfig: BreakerConfig;
  private readonly breaker: CircuitBreaker;
  private readonly governance: SourceGovernance;
  private readonly snapshots: SnapshotStore;
  private readonly metrics: OracleMetricsSink;
  private readonly now: () => number;

  /** Conservative bound from the last OK/DEGRADED price, for emergency exits. */
  private lastGoodPrice: bigint | null = null;
  private lastGoodRoundId: string | null = null;

  constructor(options: OracleServiceOptions) {
    this.adapters = new Map(options.adapters.map((a) => [a.sourceId, a]));
    this.aggregationConfig = { ...DEFAULT_AGGREGATION_CONFIG, ...options.aggregationConfig };
    this.breakerConfig = { ...DEFAULT_BREAKER_CONFIG, ...options.breakerConfig };
    this.breaker = new CircuitBreaker(this.breakerConfig);
    this.governance = new SourceGovernance(
      options.adapters.map((a) => a.sourceId),
      options.governanceTimelockMs,
    );
    this.snapshots = new SnapshotStore(options.snapshotCapacity);
    this.metrics = options.metrics ?? NULL_METRICS;
    this.now = options.now ?? (() => Date.now());
  }

  get governanceApi(): SourceGovernance {
    return this.governance;
  }

  getBreakerState(): BreakerState {
    return this.breaker.getState();
  }

  /**
   * Collect one reading per active adapter. A source that throws is a hard
   * failure: it is reported and simply contributes nothing, so one broken feed
   * can never take down a pricing round.
   */
  private async collect(asset: AssetId): Promise<PriceObservation[]> {
    const active = this.governance.getActiveSources();
    const settled = await Promise.allSettled(
      active.map((sourceId) => {
        const adapter = this.adapters.get(sourceId);
        if (!adapter) return Promise.resolve(null);
        return adapter.fetch(asset);
      }),
    );

    const observations: PriceObservation[] = [];
    settled.forEach((outcome, i) => {
      const sourceId = active[i]!;
      if (outcome.status === "fulfilled") {
        if (outcome.value !== null) observations.push(outcome.value);
      } else {
        this.metrics.onSourceFailure(sourceId, outcome.reason);
      }
    });
    return observations;
  }

  /**
   * Run a full pricing round for an asset and update the breaker. This is the
   * only method that mutates breaker state, so callers observe a consistent
   * (price, breakerState) pair.
   */
  async price(asset: AssetId): Promise<PricingResult> {
    const observations = await this.collect(asset);
    return this.priceFromObservations(asset, observations);
  }

  /**
   * Aggregate a pre-collected observation set. Exposed for concurrent-update and
   * replay tests, and used internally by `price`.
   */
  priceFromObservations(asset: AssetId, observations: PriceObservation[]): PricingResult {
    const asOf = this.now();
    const result = aggregate(asset, observations, this.aggregationConfig, asOf);

    const snapshot: StoredSnapshot = {
      result,
      inputs: observations,
      activeSources: this.governance.getActiveSources(),
    };
    this.snapshots.put(snapshot);
    this.metrics.onAggregation(result);

    const transition = this.breaker.observe(result);
    if (transition) this.metrics.onBreakerTransition(transition);

    if (result.price !== null && (result.status === "OK" || result.status === "DEGRADED_DEVIATION")) {
      this.lastGoodPrice = result.price;
      this.lastGoodRoundId = result.roundId;
    }

    return { price: result, breakerState: this.breaker.getState() };
  }

  /**
   * Gate a value-changing operation against the latest pricing result, and bind
   * it to the snapshot that priced it. The returned `roundId` is what a mint,
   * burn, or settlement records so the calculation can later be reproduced.
   */
  authorizeOperation(op: VaultOperation, result: PricingResult): OperationDecision & { roundId: string | null } {
    const decision = decideOperation(
      op,
      result.breakerState,
      result.price,
      this.breakerConfig,
      this.lastGoodPrice,
    );

    if (!decision.allowed) return { ...decision, roundId: null };

    // A live decision binds to this round; an emergency exit binds to the
    // last-good round it priced from, so both are reproducible.
    const roundId =
      result.breakerState === "OPEN" ? this.lastGoodRoundId : result.price.roundId;
    if (roundId !== null) this.snapshots.pin(roundId);
    return { ...decision, roundId };
  }

  /** Force the breaker, e.g. from an operator runbook. */
  forceBreaker(to: BreakerState, reason: string): void {
    const transition = this.breaker.forceState(to, reason);
    this.metrics.onBreakerTransition(transition);
  }

  /**
   * Reproduce a historical aggregation from its stored round id by re-running
   * the exact inputs through the aggregator. Returns both the recomputed price
   * and the originally stored one; equal values prove the calculation is
   * deterministic and reproducible.
   */
  reproduce(roundId: string): { stored: AggregatedPrice; recomputed: bigint | null } | null {
    const snapshot = this.snapshots.get(roundId);
    if (!snapshot) return null;
    const recomputed = aggregate(
      snapshot.result.asset,
      snapshot.inputs,
      this.aggregationConfig,
      snapshot.result.asOf,
    );
    return { stored: snapshot.result, recomputed: recomputed.price };
  }

  getSnapshot(roundId: string): StoredSnapshot | undefined {
    return this.snapshots.get(roundId);
  }
}
