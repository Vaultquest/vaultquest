import { Counter, Gauge, type Registry } from "prom-client";
import type { AggregatedPrice } from "./types.js";
import type { BreakerTransition } from "./circuitBreaker.js";
import type { OracleMetricsSink } from "./metrics.js";

/**
 * Prometheus-backed metrics sink for production wiring. Kept out of the core so
 * the aggregator, breaker, and service never depend on prom-client and stay
 * unit-testable with the recording double.
 *
 * The series here are the actionable ones: a rising `oracle_rejected_total`,
 * any `oracle_breaker_state > 0`, and `oracle_source_failures_total` are what an
 * alert rule watches.
 */
export class PrometheusOracleSink implements OracleMetricsSink {
  private readonly aggregationsTotal: Counter<"status">;
  private readonly rejectedTotal: Counter<"reason">;
  private readonly deviationBps: Gauge<string>;
  private readonly breakerState: Gauge<string>;
  private readonly breakerTransitionsTotal: Counter<"from" | "to">;
  private readonly sourceFailuresTotal: Counter<"source">;

  constructor(registry: Registry) {
    this.aggregationsTotal = new Counter({
      name: "oracle_aggregations_total",
      help: "Oracle aggregation rounds by status",
      labelNames: ["status"],
      registers: [registry],
    });
    this.rejectedTotal = new Counter({
      name: "oracle_rejected_total",
      help: "Observations rejected during aggregation, by reason",
      labelNames: ["reason"],
      registers: [registry],
    });
    this.deviationBps = new Gauge({
      name: "oracle_max_deviation_bps",
      help: "Worst included source deviation from the median in the latest round",
      registers: [registry],
    });
    this.breakerState = new Gauge({
      name: "oracle_breaker_state",
      help: "Circuit-breaker severity: 0 CLOSED, 1 DEGRADED, 2 OPEN",
      registers: [registry],
    });
    this.breakerTransitionsTotal = new Counter({
      name: "oracle_breaker_transitions_total",
      help: "Circuit-breaker state transitions",
      labelNames: ["from", "to"],
      registers: [registry],
    });
    this.sourceFailuresTotal = new Counter({
      name: "oracle_source_failures_total",
      help: "Hard failures fetching from a source",
      labelNames: ["source"],
      registers: [registry],
    });
  }

  onAggregation(result: AggregatedPrice): void {
    this.aggregationsTotal.inc({ status: result.status });
    this.deviationBps.set(result.maxDeviationBps);
    for (const r of result.rejected) this.rejectedTotal.inc({ reason: r.reason });
  }

  onBreakerTransition(transition: BreakerTransition): void {
    this.breakerTransitionsTotal.inc({ from: transition.from, to: transition.to });
    this.breakerState.set(severity(transition.to));
  }

  onSourceFailure(sourceId: string): void {
    this.sourceFailuresTotal.inc({ source: sourceId });
  }
}

function severity(state: BreakerTransition["to"]): number {
  return state === "OPEN" ? 2 : state === "DEGRADED" ? 1 : 0;
}
