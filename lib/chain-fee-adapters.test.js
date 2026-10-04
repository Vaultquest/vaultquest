import { describe, expect, it, vi, afterEach } from "vitest";
import {
  FEE_STALE_AFTER_MS,
  buildStellarFeeEstimate,
  classifyFeeFreshness,
  fetchStellarFeeStats,
  resolveStellarHorizonUrl,
} from "@/lib/chain-fee-adapters";

describe("resolveStellarHorizonUrl", () => {
  it("prefers custom Horizon over network defaults", () => {
    expect(
      resolveStellarHorizonUrl({
        networkType: "mainnet",
        customHorizonUrl: "https://my-horizon.example/",
      }),
    ).toBe("https://my-horizon.example");
  });

  it("uses mainnet and testnet Horizon defaults", () => {
    expect(resolveStellarHorizonUrl({ networkType: "mainnet" })).toBe(
      "https://horizon.stellar.org",
    );
    expect(resolveStellarHorizonUrl({ networkType: "testnet" })).toBe(
      "https://horizon-testnet.stellar.org",
    );
  });

  it("uses a stored custom Horizon when it differs from the default", () => {
    expect(
      resolveStellarHorizonUrl({
        networkType: "testnet",
        storedHorizonUrl: "https://custom-horizon.test",
      }),
    ).toBe("https://custom-horizon.test");
  });
});

describe("buildStellarFeeEstimate", () => {
  it("combines base fee, tier multiplier, and simulation resource fee", () => {
    const estimate = buildStellarFeeEstimate({
      baseFeeStroops: 200,
      simulationResourceFee: 4800,
      multiplier: 1.25,
      sourceLedger: "42",
      fetchedAt: new Date(),
      networkType: "testnet",
      priorityKey: "high",
    });
    expect(estimate.type).toBe("stellar");
    expect(estimate.baseFeeStroops).toBe(250);
    expect(estimate.resourceFeeStroops).toBe(4800);
    expect(estimate.feeStroops).toBe(5050);
    expect(estimate.sourceLedger).toBe("42");
    expect(estimate.isStale).toBe(false);
    expect(estimate.feeBid).toMatch(/XLM$/);
  });

  it("marks unsupported or missing ledger estimates as stale", () => {
    expect(
      buildStellarFeeEstimate({
        sourceLedger: null,
        fetchedAt: new Date(),
      }).isStale,
    ).toBe(true);
    expect(
      buildStellarFeeEstimate({
        sourceLedger: "1",
        fetchedAt: new Date(),
        isUnsupported: true,
      }).unsupported,
    ).toBe(true);
  });
});

describe("classifyFeeFreshness", () => {
  it("classifies fresh, stale, and unsupported states", () => {
    const now = Date.now();
    expect(
      classifyFeeFreshness({
        fetchedAt: new Date(now - 1_000),
        sourceLedger: "9",
        now,
      }),
    ).toBe("fresh");
    expect(
      classifyFeeFreshness({
        fetchedAt: new Date(now - FEE_STALE_AFTER_MS - 1),
        sourceLedger: "9",
        now,
      }),
    ).toBe("stale");
    expect(classifyFeeFreshness({ isUnsupported: true })).toBe("unsupported");
  });

  it("keeps malformed observation dates stale without breaking the estimate", () => {
    const now = 1_700_000_000_000;
    for (const fetchedAt of [new Date(NaN), "not-a-date"]) {
      const input = { fetchedAt, sourceLedger: "9", now };
      expect(classifyFeeFreshness(input)).toBe("stale");
      expect(buildStellarFeeEstimate(input)).toMatchObject({
        isStale: true,
        ageMs: null,
        freshness: null,
      });
    }
  });

  it("does not label a sample ahead of the caller clock as fresh", () => {
    const now = 1_700_000_000_000;
    const fetchedAt = new Date(now + 1_000);
    const input = { fetchedAt, sourceLedger: "9", now };
    expect(classifyFeeFreshness(input)).toBe("stale");
    expect(buildStellarFeeEstimate(input)).toMatchObject({
      isStale: true,
      ageMs: null,
      freshness: fetchedAt.toISOString(),
    });
  });

  it("does not infer freshness from an invalid caller clock", () => {
    const fetchedAt = new Date(1_700_000_000_000);
    for (const now of [NaN, Infinity]) {
      const input = { fetchedAt, sourceLedger: "9", now };
      expect(classifyFeeFreshness(input)).toBe("stale");
      expect(buildStellarFeeEstimate(input)).toMatchObject({
        isStale: true,
        ageMs: null,
        freshness: fetchedAt.toISOString(),
      });
    }
  });

  it("preserves zero age and the exact stale boundary for valid observations", () => {
    const now = 1_700_000_000_000;
    for (const ageMs of [0, FEE_STALE_AFTER_MS - 1, FEE_STALE_AFTER_MS]) {
      const fetchedAt = new Date(now - ageMs);
      const input = { fetchedAt, sourceLedger: "9", now };
      const isStale = ageMs >= FEE_STALE_AFTER_MS;
      expect(classifyFeeFreshness(input)).toBe(isStale ? "stale" : "fresh");
      expect(buildStellarFeeEstimate(input)).toMatchObject({
        isStale,
        ageMs,
        freshness: fetchedAt.toISOString(),
      });
    }
  });
});

describe("fetchStellarFeeStats", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses Horizon fee_stats for testnet", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ last_ledger: 111, last_ledger_base_fee: 130 }),
    });
    const result = await fetchStellarFeeStats({
      networkType: "testnet",
      customHorizonUrl: "https://horizon-testnet.stellar.org",
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://horizon-testnet.stellar.org/fee_stats",
      expect.any(Object),
    );
    expect(result.baseFeeStroops).toBe(130);
    expect(result.sourceLedger).toBe("111");
    expect(result.fresh).toBe(true);
  });

  it("throws on Horizon HTTP failures", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    await expect(
      fetchStellarFeeStats({
        customHorizonUrl: "https://horizon.example",
        fetchImpl,
      }),
    ).rejects.toThrow(/503/);
  });
});
