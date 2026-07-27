import type { AssetId, OracleAdapter, PriceObservation } from "./types.js";

/**
 * A scriptable adapter for tests and local development. It is a *test double*,
 * not a production vendor (choosing vendors is out of scope, #71). Each call to
 * `fetch` returns the next queued reading, or a fixed reading, or throws a
 * queued failure — enough to script stale feeds, malicious sources, source
 * rotation, and hard failures.
 */
export class TestAdapter implements OracleAdapter {
  private queue: Array<PriceObservation | Error | null> = [];
  private fixed: PriceObservation | null = null;

  constructor(readonly sourceId: string) {}

  /** Serve this reading on every call until changed. */
  setFixed(observation: PriceObservation | null): this {
    this.fixed = observation;
    return this;
  }

  /** Queue readings (or failures) served one per `fetch`, oldest first. */
  enqueue(...items: Array<PriceObservation | Error | null>): this {
    this.queue.push(...items);
    return this;
  }

  async fetch(_asset: AssetId): Promise<PriceObservation | null> {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (next instanceof Error) throw next;
      return next;
    }
    return this.fixed;
  }
}

/**
 * Build a well-formed observation with sensible defaults, overriding only the
 * fields a test cares about. Keeps test setup to the one axis under test.
 */
export function makeObservation(
  overrides: Partial<PriceObservation> & { sourceId: string; asset: AssetId },
): PriceObservation {
  return {
    price: 1_000000n,
    decimals: 6,
    observedAt: 0,
    confidence: 1,
    roundId: `${overrides.sourceId}-r1`,
    ...overrides,
  };
}
