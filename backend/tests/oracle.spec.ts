import { describe, it, expect } from "vitest";
import {
  aggregate,
  normalizeDecimals,
  median,
  deviationBps,
  assetEquals,
  CircuitBreaker,
  decideOperation,
  conservativePrice,
  DEFAULT_BREAKER_CONFIG,
  SourceGovernance,
  SnapshotStore,
  OracleService,
  RecordingMetricsSink,
  TestAdapter,
  makeObservation,
  DEFAULT_AGGREGATION_CONFIG,
  type AggregationConfig,
  type AssetId,
  type PriceObservation,
  type AggregatedPrice,
} from "../src/services/oracle/index.js";

const USDC: AssetId = { symbol: "USDC", contract: "CUSDC", network: "testnet" };
const CONFIG: AggregationConfig = {
  ...DEFAULT_AGGREGATION_CONFIG,
  maxStalenessMs: 60_000,
  minConfidence: 0.5,
  minSources: 3,
  maxDeviationBps: 500,
  targetDecimals: 18,
};

/** A price at the canonical 18-decimal scale. */
function px(dollars: number): bigint {
  return BigInt(Math.round(dollars * 1e6)) * 10n ** 12n; // 6dp input -> 18dp
}

function obs(sourceId: string, price: bigint, over: Partial<PriceObservation> = {}): PriceObservation {
  return makeObservation({ sourceId, asset: USDC, price, decimals: 18, observedAt: 1000, confidence: 1, ...over });
}

describe("oracle: decimal handling", () => {
  it("scales up exactly", () => {
    expect(normalizeDecimals(1_000000n, 6, 18)).toBe(1_000000n * 10n ** 12n);
  });

  it("scales down when divisible", () => {
    expect(normalizeDecimals(1_000000_000000_000000n, 18, 6)).toBe(1_000000n);
  });

  it("refuses a lossy scale-down (decimal confusion)", () => {
    // 1.0000005 at 7dp cannot be represented at 6dp without truncation.
    expect(normalizeDecimals(10_000005n, 7, 6)).toBeNull();
  });

  it("excludes a source whose precision cannot be represented", () => {
    const result = aggregate(
      USDC,
      [
        obs("a", px(1), { decimals: 6, price: 1_000000n }),
        obs("b", px(1), { decimals: 6, price: 1_000000n }),
        // 7-decimal odd value that loses precision at 18dp? scale-up is always exact,
        // so force a decimals value that would need scale-down past target.
        obs("c", 10_000001n, { decimals: 20 }),
      ],
      { ...CONFIG, targetDecimals: 18 },
      1000,
    );
    expect(result.rejected.find((r) => r.sourceId === "c")?.reason).toBe("DECIMAL_CONFUSION");
  });
});

describe("oracle: median and deviation math", () => {
  it("takes the middle of an odd set", () => {
    expect(median([3n, 1n, 2n])).toBe(2n);
  });
  it("averages the two middles of an even set", () => {
    expect(median([1n, 2n, 3n, 4n])).toBe(2n); // (2+3)/2 floors to 2
  });
  it("computes deviation in basis points", () => {
    expect(deviationBps(105n, 100n)).toBe(500);
    expect(deviationBps(95n, 100n)).toBe(500);
  });
  it("assetEquals is exact across all fields", () => {
    expect(assetEquals(USDC, { ...USDC })).toBe(true);
    expect(assetEquals(USDC, { ...USDC, network: "mainnet" })).toBe(false);
  });
});

describe("oracle: quorum aggregation", () => {
  it("produces a median from a healthy quorum", () => {
    const r = aggregate(USDC, [obs("a", px(1.0)), obs("b", px(1.01)), obs("c", px(0.99))], CONFIG, 1000);
    expect(r.status).toBe("OK");
    expect(r.price).toBe(px(1.0));
    expect(r.contributingSources.sort()).toEqual(["a", "b", "c"]);
  });

  it("reports QUORUM_LOSS when too few sources survive", () => {
    const r = aggregate(USDC, [obs("a", px(1.0)), obs("b", px(1.0))], CONFIG, 1000);
    expect(r.status).toBe("QUORUM_LOSS");
    expect(r.price).toBeNull();
  });

  it("reports NO_DATA when nothing is usable", () => {
    const r = aggregate(USDC, [], CONFIG, 1000);
    expect(r.status).toBe("NO_DATA");
    expect(r.price).toBeNull();
  });

  it("no single source determines the price under quorum", () => {
    // Four honest sources near $1, one malicious source screaming $100.
    const honest = [obs("a", px(1.0)), obs("b", px(1.01)), obs("c", px(0.99)), obs("d", px(1.0))];
    const malicious = obs("evil", px(100));
    const r = aggregate(USDC, [...honest, malicious], CONFIG, 1000);
    expect(r.price).toBe(px(1.0));
    expect(r.contributingSources).not.toContain("evil");
    expect(r.rejected.find((x) => x.sourceId === "evil")?.reason).toBe("DEVIATION_OUTLIER");
    expect(r.status).toBe("DEGRADED_DEVIATION");
  });

  it("a lone malicious source cannot flip a two-honest quorum into a wrong price", () => {
    // Only 2 honest + 1 liar: median of 3 would be swayed, but deviation-drop
    // removes the liar and quorum then fails rather than pricing wrong.
    const r = aggregate(USDC, [obs("a", px(1.0)), obs("b", px(1.0)), obs("evil", px(100))], CONFIG, 1000);
    expect(r.status).toBe("QUORUM_LOSS");
    expect(r.price).toBeNull();
  });
});

describe("oracle: freshness, confidence, sanity", () => {
  it("drops stale feeds", () => {
    // now=1000, staleness window 60s: c observed at -100_000 is 101s old.
    const r = aggregate(
      USDC,
      [obs("a", px(1.0)), obs("b", px(1.0)), obs("c", px(1.0), { observedAt: -100_000 })],
      CONFIG,
      1000,
    );
    expect(r.rejected.find((x) => x.sourceId === "c")?.reason).toBe("STALE");
    expect(r.status).toBe("QUORUM_LOSS");
  });

  it("drops low-confidence readings", () => {
    const r = aggregate(
      USDC,
      [obs("a", px(1.0)), obs("b", px(1.0)), obs("c", px(1.0), { confidence: 0.1 })],
      CONFIG,
      1000,
    );
    expect(r.rejected.find((x) => x.sourceId === "c")?.reason).toBe("LOW_CONFIDENCE");
  });

  it("rejects zero and negative prices", () => {
    const r = aggregate(USDC, [obs("a", px(1.0)), obs("b", 0n), obs("c", -5n)], CONFIG, 1000);
    const reasons = r.rejected.map((x) => x.reason);
    expect(reasons).toContain("NON_POSITIVE_PRICE");
    expect(r.rejected.filter((x) => x.reason === "NON_POSITIVE_PRICE").length).toBe(2);
  });

  it("rejects extreme prices", () => {
    const r = aggregate(
      USDC,
      [obs("a", px(1.0)), obs("b", px(1.0)), obs("c", 10n ** 40n)],
      CONFIG,
      1000,
    );
    expect(r.rejected.find((x) => x.sourceId === "c")?.reason).toBe("EXTREME_PRICE");
  });
});

describe("oracle: cross-network and wrong-asset guards", () => {
  it("excludes a mainnet reading from a testnet price", () => {
    const mainnet = obs("x", px(1.0), { asset: { ...USDC, network: "mainnet" } });
    const r = aggregate(USDC, [obs("a", px(1.0)), obs("b", px(1.0)), mainnet], CONFIG, 1000);
    expect(r.rejected.find((x) => x.sourceId === "x")?.reason).toBe("CROSS_NETWORK");
  });

  it("excludes a wrong-asset reading", () => {
    const wrong = obs("y", px(1.0), { asset: { ...USDC, contract: "CDAI", symbol: "DAI" } });
    const r = aggregate(USDC, [obs("a", px(1.0)), obs("b", px(1.0)), wrong], CONFIG, 1000);
    expect(r.rejected.find((x) => x.sourceId === "y")?.reason).toBe("WRONG_ASSET");
  });
});

describe("oracle: circuit breaker", () => {
  function ok(): AggregatedPrice {
    return aggregate(USDC, [obs("a", px(1)), obs("b", px(1)), obs("c", px(1))], CONFIG, 1000);
  }
  function quorumLoss(): AggregatedPrice {
    return aggregate(USDC, [obs("a", px(1))], CONFIG, 1000);
  }
  function deviation(): AggregatedPrice {
    return aggregate(USDC, [obs("a", px(1)), obs("b", px(1)), obs("c", px(1)), obs("d", px(1)), obs("evil", px(100))], CONFIG, 1000);
  }

  it("trips OPEN immediately on quorum loss", () => {
    const b = new CircuitBreaker(DEFAULT_BREAKER_CONFIG);
    const t = b.observe(quorumLoss());
    expect(t?.to).toBe("OPEN");
    expect(b.getState()).toBe("OPEN");
  });

  it("goes DEGRADED on a deviation while quorum holds", () => {
    const b = new CircuitBreaker(DEFAULT_BREAKER_CONFIG);
    b.observe(deviation());
    expect(b.getState()).toBe("DEGRADED");
  });

  it("recovers only after the required consecutive healthy rounds (hysteresis)", () => {
    const b = new CircuitBreaker({ ...DEFAULT_BREAKER_CONFIG, recoveryThreshold: 3 });
    b.observe(quorumLoss());
    expect(b.getState()).toBe("OPEN");
    b.observe(ok()); // 1
    expect(b.getState()).toBe("OPEN");
    b.observe(ok()); // 2
    expect(b.getState()).toBe("OPEN");
    b.observe(ok()); // 3 -> step down one level
    expect(b.getState()).toBe("DEGRADED");
    b.observe(ok());
    b.observe(ok());
    b.observe(ok()); // 3 more -> CLOSED
    expect(b.getState()).toBe("CLOSED");
  });

  it("a fault mid-recovery resets the streak", () => {
    const b = new CircuitBreaker({ ...DEFAULT_BREAKER_CONFIG, recoveryThreshold: 3 });
    b.observe(quorumLoss());
    b.observe(ok());
    b.observe(ok());
    b.observe(quorumLoss()); // resets
    b.observe(ok());
    b.observe(ok());
    expect(b.getState()).toBe("OPEN"); // only 2 healthy since reset
  });
});

describe("oracle: conservative pricing and operation gating", () => {
  it("prices deposits up and withdrawals down", () => {
    expect(conservativePrice(10_000n, "deposit", 100)).toBe(10_100n);
    expect(conservativePrice(10_000n, "withdraw", 100)).toBe(9_900n);
    expect(conservativePrice(10_000n, "valuation", 100)).toBe(10_000n);
  });

  it("CLOSED: all ops at the median price", () => {
    const price = aggregate(USDC, [obs("a", px(1)), obs("b", px(1)), obs("c", px(1))], CONFIG, 1000);
    const d = decideOperation("deposit", "CLOSED", price, DEFAULT_BREAKER_CONFIG, null);
    expect(d.allowed).toBe(true);
    expect(d.conservative).toBe(false);
    expect(d.price).toBe(px(1));
  });

  it("DEGRADED: value ops conservative, liquidation paused", () => {
    const price = aggregate(USDC, [obs("a", px(1)), obs("b", px(1)), obs("c", px(1))], CONFIG, 1000);
    const dep = decideOperation("deposit", "DEGRADED", price, DEFAULT_BREAKER_CONFIG, null);
    expect(dep.allowed).toBe(true);
    expect(dep.conservative).toBe(true);
    expect(dep.price! > px(1)).toBe(true);

    const liq = decideOperation("liquidation", "DEGRADED", price, DEFAULT_BREAKER_CONFIG, null);
    expect(liq.allowed).toBe(false);
  });

  it("OPEN: deposits blocked, withdrawals get a conservative emergency exit", () => {
    const price = aggregate(USDC, [obs("a", px(1))], CONFIG, 1000); // quorum loss, price null
    const lastGood = px(1);

    const dep = decideOperation("deposit", "OPEN", price, DEFAULT_BREAKER_CONFIG, lastGood);
    expect(dep.allowed).toBe(false);

    const wd = decideOperation("withdraw", "OPEN", price, DEFAULT_BREAKER_CONFIG, lastGood);
    expect(wd.allowed).toBe(true);
    expect(wd.conservative).toBe(true);
    expect(wd.price! < lastGood).toBe(true);
  });

  it("OPEN with no last-good snapshot cannot even exit", () => {
    const price = aggregate(USDC, [obs("a", px(1))], CONFIG, 1000);
    const wd = decideOperation("withdraw", "OPEN", price, DEFAULT_BREAKER_CONFIG, null);
    expect(wd.allowed).toBe(false);
  });
});

describe("oracle: governance timelock", () => {
  it("holds a source change until the timelock elapses", () => {
    const gov = new SourceGovernance(["a", "b", "c"], 10_000);
    gov.propose(["a", "b", "d"], "rotate c->d", 1000);
    expect(() => gov.commit(5000)).toThrow(/timelock/);
    expect(gov.getActiveSources().sort()).toEqual(["a", "b", "c"]);
    expect(gov.commit(11_000).sort()).toEqual(["a", "b", "d"]);
  });

  it("rejects an empty source set and can cancel", () => {
    const gov = new SourceGovernance(["a"], 10_000);
    expect(() => gov.propose([], "x", 0)).toThrow();
    gov.propose(["b", "c"], "y", 0);
    gov.cancel();
    expect(gov.getPending()).toBeNull();
  });
});

describe("oracle: snapshot store", () => {
  it("evicts oldest but never a pinned round", () => {
    const store = new SnapshotStore(2);
    const mk = (roundId: string): AggregatedPrice => ({
      asset: USDC, price: px(1), decimals: 18, roundId, asOf: 0, observationTime: 0,
      status: "OK", contributingSources: [], rejected: [], maxDeviationBps: 0,
    });
    store.put({ result: mk("r1"), inputs: [], activeSources: [] });
    store.pin("r1");
    store.put({ result: mk("r2"), inputs: [], activeSources: [] });
    store.put({ result: mk("r3"), inputs: [], activeSources: [] }); // would evict r1, but pinned
    expect(store.get("r1")).toBeDefined();
    expect(store.get("r3")).toBeDefined();
  });
});

describe("oracle: OracleService end to end", () => {
  function service(now: () => number, metrics = new RecordingMetricsSink()) {
    const adapters = [new TestAdapter("a"), new TestAdapter("b"), new TestAdapter("c"), new TestAdapter("d")];
    const svc = new OracleService({
      adapters,
      governanceTimelockMs: 10_000,
      aggregationConfig: CONFIG,
      now,
      metrics,
    });
    return { svc, adapters, metrics };
  }

  it("prices from live adapters and binds a reproducible round", async () => {
    const t = 1000;
    const { svc, adapters } = service(() => t);
    adapters[0]!.setFixed(obs("a", px(1.0)));
    adapters[1]!.setFixed(obs("b", px(1.01)));
    adapters[2]!.setFixed(obs("c", px(0.99)));
    adapters[3]!.setFixed(null); // this source has nothing

    const result = await svc.price(USDC);
    expect(result.price.status).toBe("OK");
    expect(result.price.price).toBe(px(1.0));

    const auth = svc.authorizeOperation("deposit", result);
    expect(auth.allowed).toBe(true);
    expect(auth.roundId).toBe(result.price.roundId);

    const rep = svc.reproduce(auth.roundId!);
    expect(rep).not.toBeNull();
    expect(rep!.recomputed).toBe(rep!.stored.price);
  });

  it("survives a source that throws (hard failure) and alerts", async () => {
    const t = 1000;
    const { svc, adapters, metrics } = service(() => t);
    adapters[0]!.setFixed(obs("a", px(1.0)));
    adapters[1]!.setFixed(obs("b", px(1.0)));
    adapters[2]!.setFixed(obs("c", px(1.0)));
    adapters[3]!.enqueue(new Error("feed down"));

    const result = await svc.price(USDC);
    expect(result.price.status).toBe("OK");
    expect(metrics.sourceFailures.map((f) => f.sourceId)).toContain("d");
  });

  it("rapid volatility trips then recovers the breaker with matching alerts", async () => {
    const t = 1000;
    const { svc, adapters, metrics } = service(() => t);
    const set = (p: number) => {
      adapters[0]!.setFixed(obs("a", px(p)));
      adapters[1]!.setFixed(obs("b", px(p)));
      adapters[2]!.setFixed(obs("c", px(p)));
    };

    set(1.0);
    await svc.price(USDC);
    expect(svc.getBreakerState()).toBe("CLOSED");

    // Sudden quorum loss: two feeds drop out.
    adapters[1]!.setFixed(null);
    adapters[2]!.setFixed(null);
    await svc.price(USDC);
    expect(svc.getBreakerState()).toBe("OPEN");

    // Emergency exit still works off the last-good snapshot.
    const openResult = await svc.price(USDC);
    const wd = svc.authorizeOperation("withdraw", openResult);
    expect(wd.allowed).toBe(true);
    expect(wd.conservative).toBe(true);

    // Feeds return; breaker recovers after the threshold.
    set(1.0);
    for (let i = 0; i < DEFAULT_BREAKER_CONFIG.recoveryThreshold * 2; i++) await svc.price(USDC);
    expect(svc.getBreakerState()).toBe("CLOSED");

    expect(metrics.breakerTransitions.some((x) => x.to === "OPEN")).toBe(true);
    expect(metrics.breakerTransitions.some((x) => x.to === "CLOSED")).toBe(true);
  });

  it("source rotation via governance changes the contributing set", async () => {
    let t = 1000;
    const { svc, adapters } = service(() => t);
    adapters.forEach((a, i) => a.setFixed(obs(["a", "b", "c", "d"][i]!, px(1.0))));

    const before = await svc.price(USDC);
    expect(before.price.contributingSources).toContain("d");

    // Rotate d out. Timelock blocks an instant swap.
    svc.governanceApi.propose(["a", "b", "c"], "drop d", t);
    expect(() => svc.governanceApi.commit(t + 1)).toThrow(/timelock/);
    t += 20_000;
    svc.governanceApi.commit(t);

    const after = await svc.price(USDC);
    expect(after.price.contributingSources).not.toContain("d");
    expect(after.price.status).toBe("OK");
  });

  it("concurrent pricing rounds each bind their own snapshot", async () => {
    const t = 1000;
    const { svc, adapters } = service(() => t);
    adapters.forEach((a, i) => a.setFixed(obs(["a", "b", "c", "d"][i]!, px(1.0))));

    const [r1, r2, r3] = await Promise.all([svc.price(USDC), svc.price(USDC), svc.price(USDC)]);
    const ids = [r1.price.roundId, r2.price.roundId, r3.price.roundId];
    expect(new Set(ids).size).toBe(3); // unique round ids, no collision
    for (const id of ids) {
      const rep = svc.reproduce(id);
      expect(rep!.recomputed).toBe(rep!.stored.price);
    }
  });

  it("historical calculations remain reproducible after the source set changes", async () => {
    let t = 1000;
    const { svc, adapters } = service(() => t);
    adapters.forEach((a, i) => a.setFixed(obs(["a", "b", "c", "d"][i]!, px(1.0))));
    const historical = await svc.price(USDC);
    const roundId = historical.price.roundId;

    // Rotate sources later.
    svc.governanceApi.propose(["a", "b", "c"], "drop d", t);
    t += 20_000;
    svc.governanceApi.commit(t);
    adapters.forEach((a, i) => a.setFixed(obs(["a", "b", "c", "d"][i]!, px(2.0))));
    await svc.price(USDC);

    // The old round still reproduces its original $1 price from stored inputs.
    const rep = svc.reproduce(roundId);
    expect(rep!.stored.price).toBe(px(1.0));
    expect(rep!.recomputed).toBe(px(1.0));
  });
});
