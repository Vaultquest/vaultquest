import { describe, it, expect } from "vitest";
import {
  VIRTUAL_SHARES,
  computeDepositSharesPreview,
  isPoolStateStale,
  formatShareAmount,
  VaultMathError,
} from "./shareMath";

describe("shareMath contract preview calculations", () => {
  it("mints first deposit shares at the virtual baseline", () => {
    const pool = { tvl: "0", totalShares: "0" };
    const shares = computeDepositSharesPreview(pool, 1_000_000n);
    expect(shares).toBe(1_000_000n * VIRTUAL_SHARES);
  });

  it("rejects non-positive deposit amounts", () => {
    const pool = { tvl: "1000", totalShares: "1000" };
    expect(() => computeDepositSharesPreview(pool, 0n)).toThrowError(VaultMathError);
    expect(() => computeDepositSharesPreview(pool, -10n)).toThrowError(VaultMathError);
  });

  it("rejects dust deposits that round to zero shares", () => {
    const pool = { tvl: "2000000", totalShares: "0" };
    expect(() => computeDepositSharesPreview(pool, 1n)).toThrowError(VaultMathError);
    try {
      computeDepositSharesPreview(pool, 1n);
    } catch (err) {
      expect((err as VaultMathError).kind).toBe("RoundsToZero");
    }
  });

  it("identifies stale pool states past 120 seconds", () => {
    const now = 1_700_000_000_000;
    const freshTime = new Date(now - 30_000).toISOString();
    const staleTime = new Date(now - 125_000).toISOString();
    expect(isPoolStateStale(freshTime, now)).toBe(false);
    expect(isPoolStateStale(staleTime, now)).toBe(true);
  });

  it("formats share amounts properly", () => {
    expect(formatShareAmount(10_000_000n, 7)).toBe("1");
    expect(formatShareAmount(15_500_000n, 7)).toBe("1.55");
  });
});
