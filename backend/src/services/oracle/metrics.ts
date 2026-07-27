import type { AggregatedPrice } from "./types.js";
import type { BreakerTransition } from "./circuitBreaker.js";

/**
 * Where the oracle reports what it saw. Injected rather than reaching for a
 * global registry so the core stays pure and tests can assert on emissions.
 * Oracle failures and deviations are actionable, so each has its own signal.
 */
export interface OracleMetricsSink {
  onAggregation(result: AggregatedPrice): void;
  onBreakerTransition(transition: BreakerTransition): void;
  onSourceFailure(sourceId: string, error: unknown): void;
}

/** No-op sink for callers that do not care about metrics. */
export const NULL_METRICS: OracleMetricsSink = {
  onAggregation() {},
  onBreakerTransition() {},
  onSourceFailure() {},
};

export interface RecordedAggregation {
  roundId: string;
  status: AggregatedPrice["status"];
  maxDeviationBps: number;
  rejectedCount: number;
}

/**
 * Test/inspection double that records everything. Doubles as a lightweight
 * alerting surface: `breakerTransitions` and `sourceFailures` are exactly the
 * events an on-call rotation would page on.
 */
export class RecordingMetricsSink implements OracleMetricsSink {
  readonly aggregations: RecordedAggregation[] = [];
  readonly breakerTransitions: BreakerTransition[] = [];
  readonly sourceFailures: Array<{ sourceId: string; error: unknown }> = [];

  onAggregation(result: AggregatedPrice): void {
    this.aggregations.push({
      roundId: result.roundId,
      status: result.status,
      maxDeviationBps: result.maxDeviationBps,
      rejectedCount: result.rejected.length,
    });
  }

  onBreakerTransition(transition: BreakerTransition): void {
    this.breakerTransitions.push(transition);
  }

  onSourceFailure(sourceId: string, error: unknown): void {
    this.sourceFailures.push({ sourceId, error });
  }
}
