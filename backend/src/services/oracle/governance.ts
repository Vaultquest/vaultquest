import type { AggregatedPrice, PriceObservation } from "./types.js";

/**
 * Governance for the source set, plus the historical snapshot store.
 *
 * Changing which feeds back a price is a value-relevant act — a compromised
 * governance key that could swap in a malicious source instantly would defeat
 * the whole quorum. Changes are therefore proposed, then committable only after
 * a timelock, giving holders a window to react.
 */

export interface SourceSetProposal {
  sources: string[];
  proposedAt: number;
  /** Earliest time the proposal may be committed. */
  effectiveAt: number;
  reason: string;
}

export class SourceGovernance {
  private active: Set<string>;
  private pending: SourceSetProposal | null = null;

  constructor(
    initialSources: string[],
    private readonly timelockMs: number,
  ) {
    this.active = new Set(initialSources);
  }

  getActiveSources(): string[] {
    return [...this.active];
  }

  isActive(sourceId: string): boolean {
    return this.active.has(sourceId);
  }

  getPending(): SourceSetProposal | null {
    return this.pending;
  }

  /** Propose a new active source set. Overwrites any un-committed proposal. */
  propose(sources: string[], reason: string, now: number): SourceSetProposal {
    if (sources.length === 0) {
      throw new Error("source set cannot be empty");
    }
    const proposal: SourceSetProposal = {
      sources: [...new Set(sources)],
      proposedAt: now,
      effectiveAt: now + this.timelockMs,
      reason,
    };
    this.pending = proposal;
    return proposal;
  }

  /**
   * Commit the pending proposal. Rejected before the timelock elapses, which is
   * the whole point — the change cannot take effect faster than holders can see
   * it coming.
   */
  commit(now: number): string[] {
    if (this.pending === null) {
      throw new Error("no pending source-set proposal");
    }
    if (now < this.pending.effectiveAt) {
      throw new Error(`timelock active: committable at ${this.pending.effectiveAt}, now ${now}`);
    }
    this.active = new Set(this.pending.sources);
    this.pending = null;
    return this.getActiveSources();
  }

  cancel(): void {
    this.pending = null;
  }
}

/** Everything needed to reproduce one aggregation exactly. */
export interface StoredSnapshot {
  result: AggregatedPrice;
  /** The raw observations that were fed in, retained verbatim. */
  inputs: PriceObservation[];
  /** The active source set at aggregation time. */
  activeSources: string[];
}

/**
 * Append-only store of aggregation snapshots keyed by round id. Historical NAV,
 * rewards, and settlement calculations are reproducible from a stored round id
 * because both the output and its exact inputs are retained.
 *
 * A `maxEntries` bound keeps the in-memory double from growing without limit; a
 * production store would persist these. Eviction is oldest-first and never
 * touches a round that has been pinned by a settlement.
 */
export class SnapshotStore {
  private readonly byRound = new Map<string, StoredSnapshot>();
  private readonly order: string[] = [];
  private readonly pinned = new Set<string>();

  constructor(private readonly maxEntries = 10_000) {}

  put(snapshot: StoredSnapshot): void {
    const { roundId } = snapshot.result;
    if (!this.byRound.has(roundId)) this.order.push(roundId);
    this.byRound.set(roundId, snapshot);
    this.evictIfNeeded();
  }

  get(roundId: string): StoredSnapshot | undefined {
    return this.byRound.get(roundId);
  }

  /** Mark a round as bound to a settlement so it is never evicted. */
  pin(roundId: string): void {
    if (this.byRound.has(roundId)) this.pinned.add(roundId);
  }

  size(): number {
    return this.byRound.size;
  }

  private evictIfNeeded(): void {
    while (this.byRound.size > this.maxEntries && this.order.length > 0) {
      const oldest = this.order.shift();
      if (oldest === undefined) break;
      if (this.pinned.has(oldest)) {
        // Keep pinned rounds; push them back to the tail so we don't spin.
        this.order.push(oldest);
        // If every remaining round is pinned we cannot evict further.
        if (this.order.every((r) => this.pinned.has(r))) break;
        continue;
      }
      this.byRound.delete(oldest);
    }
  }
}
