import type { AggregatedPrice } from "./types.js";

/**
 * Circuit-breaker states, worst-last.
 *
 *  - CLOSED   normal operation; the median price is used as-is.
 *  - DEGRADED sources disagreed but a quorum still held. Value-changing ops are
 *             allowed only at a conservative price; liquidations are paused.
 *  - OPEN     no trustworthy price. Deposits and valuations that could mint
 *             shares or hide insolvency are blocked. Withdrawals are allowed
 *             only under the emergency safe-exit rule.
 */
export type BreakerState = "CLOSED" | "DEGRADED" | "OPEN";

export type VaultOperation = "deposit" | "withdraw" | "valuation" | "liquidation";

export interface BreakerConfig {
  /** Consecutive healthy rounds required to step one level back toward CLOSED. */
  recoveryThreshold: number;
  /**
   * Conservative haircut applied in DEGRADED/OPEN, in basis points. Deposits are
   * priced *up* by this (mint fewer shares); withdrawals are priced *down* by it
   * (pay out less). Both directions protect remaining holders' solvency.
   */
  conservativeHaircutBps: number;
}

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  recoveryThreshold: 3,
  conservativeHaircutBps: 100, // 1%
};

export interface BreakerTransition {
  from: BreakerState;
  to: BreakerState;
  reason: string;
}

const SEVERITY: Record<BreakerState, number> = { CLOSED: 0, DEGRADED: 1, OPEN: 2 };

/**
 * Drives the breaker from a stream of aggregation results. Tripping is
 * immediate (one bad round opens the breaker); recovery is deliberate
 * (`recoveryThreshold` consecutive healthy rounds to step back one level),
 * which is the hysteresis that stops a flapping feed from oscillating the gate.
 */
export class CircuitBreaker {
  private state: BreakerState = "CLOSED";
  private healthyStreak = 0;

  constructor(private readonly config: BreakerConfig = DEFAULT_BREAKER_CONFIG) {}

  getState(): BreakerState {
    return this.state;
  }

  /** The state a single aggregation result argues for, ignoring history. */
  private demandedState(price: AggregatedPrice): BreakerState {
    switch (price.status) {
      case "QUORUM_LOSS":
      case "NO_DATA":
        return "OPEN";
      case "DEGRADED_DEVIATION":
        return "DEGRADED";
      case "OK":
        return "CLOSED";
    }
  }

  /**
   * Feed one aggregation result. Returns a transition when the state changed,
   * else null. A result that demands a worse state trips immediately; a healthy
   * result advances recovery and only steps down after the threshold.
   */
  observe(price: AggregatedPrice): BreakerTransition | null {
    const demanded = this.demandedState(price);
    const from = this.state;

    if (SEVERITY[demanded] > SEVERITY[this.state]) {
      this.healthyStreak = 0;
      this.state = demanded;
      return { from, to: this.state, reason: `tripped by ${price.status}` };
    }

    if (SEVERITY[demanded] < SEVERITY[this.state]) {
      // Strictly-improving round: the only thing that advances recovery.
      this.healthyStreak += 1;
      if (this.healthyStreak >= this.config.recoveryThreshold) {
        this.healthyStreak = 0;
        this.state = stepDown(this.state);
        return { from, to: this.state, reason: `recovered after ${this.config.recoveryThreshold} healthy rounds` };
      }
      return null;
    }

    // demanded === current: a non-improving round. At CLOSED it is simply
    // normal; while faulted it means the fault persists at this level, which
    // interrupts any recovery in progress. Either way the streak resets.
    this.healthyStreak = 0;
    return null;
  }

  /** Operator override, e.g. after a manual investigation. */
  forceState(to: BreakerState, reason: string): BreakerTransition {
    const from = this.state;
    this.state = to;
    this.healthyStreak = 0;
    return { from, to, reason: `forced: ${reason}` };
  }
}

function stepDown(state: BreakerState): BreakerState {
  return state === "OPEN" ? "DEGRADED" : "CLOSED";
}

export interface OperationDecision {
  allowed: boolean;
  /** Price the operation must use, or null when blocked. */
  price: bigint | null;
  /** True when `price` was moved off the median by the conservative rule. */
  conservative: boolean;
  reason: string;
}

/**
 * Apply the conservative haircut in the solvency-protecting direction.
 *
 * A deposit that prices assets *higher* mints *fewer* shares, so a manipulated
 * low price can't mint excess shares. A withdrawal that prices assets *lower*
 * pays out *less*, so a manipulated high price can't drain the pool. Both err
 * against the actor and in favour of the holders who remain.
 */
export function conservativePrice(price: bigint, op: VaultOperation, haircutBps: number): bigint {
  const bps = BigInt(haircutBps);
  if (op === "deposit") return (price * (10_000n + bps)) / 10_000n;
  if (op === "withdraw" || op === "liquidation") return (price * (10_000n - bps)) / 10_000n;
  return price; // valuation reads the unadjusted median
}

/**
 * The policy gate every value-changing operation passes through.
 *
 * `emergencyPrice` is the conservative bound from the last trustworthy snapshot;
 * it is what makes an OPEN-state withdrawal a *safe* exit rather than a blocked
 * one. Deposits and liquidations get no such fallback — there is no safe way to
 * take new money in or seize collateral against a price you don't trust.
 */
export function decideOperation(
  op: VaultOperation,
  state: BreakerState,
  current: AggregatedPrice,
  config: BreakerConfig,
  emergencyPrice: bigint | null,
): OperationDecision {
  if (state === "CLOSED") {
    if (current.price === null) {
      return { allowed: false, price: null, conservative: false, reason: "no price despite closed breaker" };
    }
    return { allowed: true, price: current.price, conservative: false, reason: "normal" };
  }

  if (state === "DEGRADED") {
    if (current.price === null) {
      return { allowed: false, price: null, conservative: false, reason: "degraded with no price" };
    }
    if (op === "liquidation") {
      return { allowed: false, price: null, conservative: false, reason: "liquidations paused while degraded" };
    }
    const price = conservativePrice(current.price, op, config.conservativeHaircutBps);
    return { allowed: true, price, conservative: true, reason: "degraded: conservative price" };
  }

  // OPEN: no trustworthy live price.
  if (op === "withdraw") {
    if (emergencyPrice === null) {
      return { allowed: false, price: null, conservative: false, reason: "open with no last-good snapshot" };
    }
    const price = conservativePrice(emergencyPrice, "withdraw", config.conservativeHaircutBps);
    return { allowed: true, price, conservative: true, reason: "emergency safe-exit at conservative last-good price" };
  }

  return { allowed: false, price: null, conservative: false, reason: `${op} blocked while breaker open` };
}
