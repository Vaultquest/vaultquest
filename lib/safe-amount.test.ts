import { describe, it, expect } from "vitest";
import {
  PPS_SCALE,
  VIRTUAL_SHARES,
  VIRTUAL_ASSETS,
  SECONDS_PER_YEAR,
  VAULT_DATA_STALE_AFTER_MS,
  VaultMathError,
  normalizeSnapshot,
  mulDivFloor,
  mulDivCeil,
  netAssets,
  virtualShares,
  virtualAssets,
  pricePerShare,
  accrueManagementFee,
  accruePerformanceFee,
  previewDeposit,
  previewRedeem,
  previewMint,
  previewWithdraw,
  previewDepositDetailed,
  parseAssetAmount,
  formatAssetAmount,
  isPoolStateStale,
  type RawVaultSnapshot,
} from "./safe-amount";

function fresh(): RawVaultSnapshot {
  return {
    total_shares: 0n,
    total_assets: 0n,
    pending_withdrawals: 0n,
    accrued_fees: 0n,
    donated_assets: 0n,
    dust: 0n,
    high_water_mark: 0n,
    last_fee_time: 0n,
    version: 0n,
  };
}

describe("safe-amount vault share math and rounding", () => {
  it("mints first deposit shares at the virtual baseline", () => {
    const snap = fresh();
    const minted = previewDeposit(snap, 1_000_000n);
    expect(minted).toBe(1_000_000n * VIRTUAL_SHARES);
  });

  it("yields equal shares for equal successive deposits at parity", () => {
    const snap = fresh();
    const firstMint = previewDeposit(snap, 500n);
    const updatedSnap: RawVaultSnapshot = {
      ...snap,
      total_assets: 500n,
      total_shares: firstMint,
      version: 1n,
    };
    const secondMint = previewDeposit(updatedSnap, 500n);
    expect(firstMint).toBe(500n * VIRTUAL_SHARES);
    expect(secondMint).toBe(firstMint);
  });

  it("rejects non-positive deposit amounts with InvalidAmount", () => {
    const snap = fresh();
    expect(() => previewDeposit(snap, 0n)).toThrowError(VaultMathError);
    expect(() => previewDeposit(snap, 0n)).toThrow("Deposit amount must be positive");
    expect(() => previewDeposit(snap, -10n)).toThrowError(VaultMathError);
  });

  it("rejects deposits too small to mint a share with RoundsToZero", () => {
    const snap: RawVaultSnapshot = {
      ...fresh(),
      total_shares: 0n,
      total_assets: 2_000_000n,
    };
    expect(() => previewDeposit(snap, 1n)).toThrowError(VaultMathError);
    try {
      previewDeposit(snap, 1n);
    } catch (err) {
      expect(err).toBeInstanceOf(VaultMathError);
      expect((err as VaultMathError).kind).toBe("RoundsToZero");
    }
  });

  it("favors existing holders on redeem vs mint rounding boundaries", () => {
    const snap: RawVaultSnapshot = {
      ...fresh(),
      total_shares: 3_000_000_000n,
      total_assets: 10_000_000_000n,
    };
    const redeemAssets = previewRedeem(snap, 1n);
    const mintAssets = previewMint(snap, 1n);
    expect(redeemAssets).toBe(3n);
    expect(mintAssets).toBe(4n);
  });

  it("favors existing holders on deposit vs withdraw rounding boundaries", () => {
    const snap: RawVaultSnapshot = {
      ...fresh(),
      total_shares: 3_000_000_000n,
      total_assets: 10_000_000_000n,
    };
    const depositShares = previewDeposit(snap, 4n);
    const withdrawShares = previewWithdraw(snap, 4n);
    expect(depositShares).toBe(1n);
    expect(withdrawShares).toBe(2n);
  });

  it("rejects redemption exceeding outstanding total shares", () => {
    const snap: RawVaultSnapshot = {
      ...fresh(),
      total_shares: 100n,
      total_assets: 100n,
    };
    expect(() => previewRedeem(snap, 101n)).toThrowError(VaultMathError);
    try {
      previewRedeem(snap, 101n);
    } catch (err) {
      expect((err as VaultMathError).kind).toBe("InsufficientShares");
    }
  });

  it("rejects withdrawal exceeding net assets backing the pool", () => {
    const snap: RawVaultSnapshot = {
      ...fresh(),
      total_shares: 500n,
      total_assets: 500n,
      pending_withdrawals: 200n,
    };
    expect(() => previewWithdraw(snap, 301n)).toThrowError(VaultMathError);
    try {
      previewWithdraw(snap, 301n);
    } catch (err) {
      expect((err as VaultMathError).kind).toBe("InsufficientBalance");
    }
  });
});

describe("safe-amount fee accrual and checkpointing", () => {
  it("accrues management fee pro-rata over elapsed seconds exactly", () => {
    const snap = normalizeSnapshot({
      ...fresh(),
      total_assets: 1_000_000n,
      total_shares: 1_000_000n * VIRTUAL_SHARES,
      last_fee_time: 0n,
    });
    const halfYear = SECONDS_PER_YEAR / 2n;
    const { fee, nextSnapshot } = accrueManagementFee(snap, halfYear, 1_000n);
    expect(fee).toBe(50_000n);
    expect(nextSnapshot.accrued_fees).toBe(50_000n);
    expect(nextSnapshot.last_fee_time).toBe(halfYear);
  });

  it("returns zero fee for zero elapsed time or zero rate", () => {
    const snap = normalizeSnapshot({
      ...fresh(),
      total_assets: 1_000_000n,
      last_fee_time: 1_000n,
    });
    const zeroTime = accrueManagementFee(snap, 1_000n, 1_000n);
    expect(zeroTime.fee).toBe(0n);
    const zeroRate = accrueManagementFee(snap, 2_000n, 0n);
    expect(zeroRate.fee).toBe(0n);
  });

  it("charges performance fee only on gains exceeding high-water mark", () => {
    const baseSnap = normalizeSnapshot({
      ...fresh(),
      total_assets: 1_000_000n,
      total_shares: 1_000_000n * VIRTUAL_SHARES,
      last_fee_time: 0n,
    });
    const noGain = accruePerformanceFee(baseSnap, 2_000n);
    expect(noGain.fee).toBe(0n);

    const withGainSnap: RawVaultSnapshot = {
      ...baseSnap,
      total_assets: 1_500_000n,
    };
    const normWithGain = normalizeSnapshot(withGainSnap);
    normWithGain.high_water_mark = baseSnap.high_water_mark;

    const charged = accruePerformanceFee(normWithGain, 2_000n);
    expect(charged.fee).toBeGreaterThan(0n);

    const secondCharge = accruePerformanceFee(charged.nextSnapshot, 2_000n);
    expect(secondCharge.fee).toBe(0n);
  });
});

describe("safe-amount parsing, formatting, and staleness detection", () => {
  it("parses valid decimal strings without IEEE-754 precision distortion", () => {
    const parsed = parseAssetAmount("123.4567000", 7);
    expect(parsed).not.toBeNull();
    expect(parsed!.minorUnits).toBe(1234567000n);
    expect(parsed!.decimal).toBe("123.4567000");
  });

  it("rejects sub-stroop precision exceeding asset decimals", () => {
    expect(parseAssetAmount("1.12345678", 7)).toBeNull();
  });

  it("rejects malformed numbers and non-numeric inputs", () => {
    expect(parseAssetAmount("abc", 7)).toBeNull();
    expect(parseAssetAmount("-50.2", 7)).toBeNull();
    expect(parseAssetAmount("1.2.3", 7)).toBeNull();
  });

  it("formats minor units to canonical string representation", () => {
    expect(formatAssetAmount(1234567000n, 7)).toBe("123.4567");
    expect(formatAssetAmount(5000000n, 7)).toBe("0.5");
    expect(formatAssetAmount(100n, 2)).toBe("1");
    expect(formatAssetAmount(105n, 2)).toBe("1.05");
  });

  it("flags pool state older than 2 minutes as stale", () => {
    const now = 1_700_000_000_000;
    const freshDate = new Date(now - 30_000).toISOString();
    const staleDate = new Date(now - (VAULT_DATA_STALE_AFTER_MS + 1_000)).toISOString();
    expect(isPoolStateStale(freshDate, now)).toBe(false);
    expect(isPoolStateStale(staleDate, now)).toBe(true);
    expect(isPoolStateStale(null, now)).toBe(true);
    expect(isPoolStateStale(undefined, now)).toBe(true);
  });

  it("executes comprehensive previewDepositDetailed calculation", () => {
    const snap: RawVaultSnapshot = {
      ...fresh(),
      total_assets: 1_000_000n,
      total_shares: 1_000_000n * VIRTUAL_SHARES,
      updatedAt: new Date(Date.now() - 10_000).toISOString(),
    };
    const result = previewDepositDetailed({
      snapshot: snap,
      assets: 250_000n,
      feeConfig: {
        management_fee_bps: 0n,
        performance_fee_bps: 0n,
      },
    });

    expect(result.sharesMinted).toBeGreaterThan(0n);
    expect(result.isStale).toBe(false);
    expect(result.totalSharesAfter).toBe(result.totalSharesBefore + result.sharesMinted);
    expect(result.netAssetsAfter).toBe(result.netAssetsBefore + 250_000n);
    expect(result.poolShareBps).toBeGreaterThan(0n);
  });
});
