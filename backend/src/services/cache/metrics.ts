/**
 * Where the generic cache reports what it did on each `getOrSet` call.
 * Injected rather than reaching for a global registry so the core stays pure
 * and tests can assert on emissions (same pattern as services/oracle/metrics).
 *
 * The four outcomes map to the thundering-herd failure modes the cache
 * protects against: `hit` (fresh read), `coalesced` (waited on an in-flight
 * fetch for the same key), `stale` (served an expired value inside the
 * staleness window), and `miss` (owned a source fetch). `sourceFailure` fires
 * whenever a source fetch fails.
 */
export interface CacheMetricsSink {
  onHit(key: string): void;
  onCoalesced(key: string): void;
  onStale(key: string): void;
  onMiss(key: string): void;
  onSourceFailure(key: string, error: unknown): void;
}

/** No-op sink for callers that do not care about metrics. */
export const NULL_METRICS: CacheMetricsSink = {
  onHit() {},
  onCoalesced() {},
  onStale() {},
  onMiss() {},
  onSourceFailure() {},
};

export interface RecordedFailure {
  key: string;
  error: unknown;
}

/**
 * Test/inspection double that records every emission. `hits`, `coalesced`,
 * `stale`, and `misses` are exactly the four acceptance-criteria outcomes, so
 * assertions read directly from the issue.
 */
export class RecordingCacheMetrics implements CacheMetricsSink {
  hits: string[] = [];
  coalesced: string[] = [];
  stale: string[] = [];
  misses: string[] = [];
  failures: RecordedFailure[] = [];

  onHit(key: string): void {
    this.hits.push(key);
  }

  onCoalesced(key: string): void {
    this.coalesced.push(key);
  }

  onStale(key: string): void {
    this.stale.push(key);
  }

  onMiss(key: string): void {
    this.misses.push(key);
  }

  onSourceFailure(key: string, error: unknown): void {
    this.failures.push({ key, error });
  }

  reset(): void {
    this.hits = [];
    this.coalesced = [];
    this.stale = [];
    this.misses = [];
    this.failures = [];
  }
}
