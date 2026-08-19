import { describe, it, expect } from "vitest";
import { parseAssetAmount, assetAmountFrom, zeroAssetAmount, compareAssetAmounts, STELLAR_DECIMALS } from "./amount.js";

describe("parseAssetAmount (issue #106)", () => {
  it("round-trips a maximum-safe-boundary XLM amount exactly (integer part beyond 2^53)", () => {
    // 2^53 = 9007199254740992; well past JS safe-integer range once you
    // factor in 7 decimal places.
    const raw = "9007199254740992.1234567";
    const parsed = parseAssetAmount(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.decimal).toBe(raw);
    expect(parsed!.minorUnits.toString()).toBe("90071992547409921234567");
    // The bug this replaces: Number(raw) can't represent this magnitude
    // with 7 fractional digits - it rounds the fraction away entirely.
    expect(Number(raw)).toBe(9007199254740992);
    expect(parsed!.decimal).not.toBe(String(Number(raw)));
  });

  it("round-trips every valid 7-decimal Stellar amount exactly", () => {
    const cases = ["0.0000001", "1.0000000", "42.5000000", "100.0000000", "0.1234567"];
    for (const raw of cases) {
      const parsed = parseAssetAmount(raw);
      expect(parsed).not.toBeNull();
      expect(parsed!.decimal).toBe(raw);
    }
  });

  it("rejects sub-stroop precision (more fractional digits than the asset supports)", () => {
    expect(parseAssetAmount("1.12345678")).toBeNull(); // 8 fractional digits
    expect(parseAssetAmount("0.00000001", STELLAR_DECIMALS)).toBeNull();
  });

  it("rejects malformed / scientific-notation / signed input rather than guessing", () => {
    expect(parseAssetAmount("1e10")).toBeNull();
    expect(parseAssetAmount("-5")).toBeNull();
    expect(parseAssetAmount("abc")).toBeNull();
    expect(parseAssetAmount("")).toBeNull();
    expect(parseAssetAmount("1.2.3")).toBeNull();
  });

  it("respects a smaller asset decimals configuration", () => {
    const parsed = parseAssetAmount("10.50", 2);
    expect(parsed).not.toBeNull();
    expect(parsed!.minorUnits.toString()).toBe("1050");
    expect(parseAssetAmount("10.501", 2)).toBeNull(); // exceeds 2-decimal precision
  });
});

describe("assetAmountFrom / zeroAssetAmount", () => {
  it("attaches asset code/issuer/decimals to every amount", () => {
    const amt = assetAmountFrom("USDC", "GISSUER", "10.0000000");
    expect(amt).toEqual({
      assetCode: "USDC",
      assetIssuer: "GISSUER",
      decimals: 7,
      decimal: "10.0000000",
      minorUnits: "100000000",
    });
  });

  it("zeroAssetAmount carries the same asset identity as a real zero balance", () => {
    expect(zeroAssetAmount("XLM", "native")).toEqual({
      assetCode: "XLM",
      assetIssuer: "native",
      decimals: 7,
      decimal: "0",
      minorUnits: "0",
    });
  });
});

describe("compareAssetAmounts", () => {
  it("compares exactly via BigInt, never IEEE-754", () => {
    const a = assetAmountFrom("XLM", "native", "9007199254740992.1234567")!;
    const b = assetAmountFrom("XLM", "native", "9007199254740992.1234568")!;
    expect(compareAssetAmounts(a, b)).toBeLessThan(0);
    expect(compareAssetAmounts(b, a)).toBeGreaterThan(0);
    expect(compareAssetAmounts(a, a)).toBe(0);
  });
});
