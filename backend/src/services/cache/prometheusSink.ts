import { Counter, type Registry } from "prom-client";
import type { CacheMetricsSink } from "./metrics.js";

/**
 * Prometheus-backed metrics sink for production wiring. Kept out of the core
 * so CacheService never depends on prom-client and stays unit-testable with
 * the recording double.
 *
 * Keys are deliberately NOT used as label values: cache keys are unbounded
 * (wallet addresses, tx hashes), so they would blow up the label cardinality.
 * The series below are the actionable ones — a rising
 * `cache_get_or_set_total{outcome="source_failure"}` or a long tail of
 * `coalesced` requests is what an alert rule watches.
 */
export class PrometheusCacheSink implements CacheMetricsSink {
  private readonly getOrSetTotal: Counter<"outcome">;
  private readonly sourceFailuresTotal: Counter<string>;

  constructor(registry: Registry) {
    this.getOrSetTotal = new Counter({
      name: "cache_get_or_set_total",
      help: "Generic cache getOrSet outcomes: hit, coalesced, stale, miss, source_failure",
      labelNames: ["outcome"],
      registers: [registry],
    });
    this.sourceFailuresTotal = new Counter({
      name: "cache_source_failures_total",
      help: "Source fetches that failed inside the generic cache",
      registers: [registry],
    });
  }

  onHit(): void {
    this.getOrSetTotal.inc({ outcome: "hit" });
  }

  onCoalesced(): void {
    this.getOrSetTotal.inc({ outcome: "coalesced" });
  }

  onStale(): void {
    this.getOrSetTotal.inc({ outcome: "stale" });
  }

  onMiss(): void {
    this.getOrSetTotal.inc({ outcome: "miss" });
  }

  onSourceFailure(): void {
    this.getOrSetTotal.inc({ outcome: "source_failure" });
    this.sourceFailuresTotal.inc();
  }
}
