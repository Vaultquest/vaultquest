import { describe, it, expect } from "vitest";
import {
  attachDrawProof,
  flagDisputed,
  hasProof,
  verifyDrawProof,
} from "./draw-proof";
import type { RewardHistoryEntry } from "../contract/types";

const baseEntry: RewardHistoryEntry = {
  id: "r1",
  poolId: "pool-1",
  poolName: "Weekly USDC",
  cycleEndedAt: "2026-05-09T00:00:00Z",
  rewardAmount: "42",
  asset: "USDC",
  status: "won",
  winnerAddress: null,
  txHash: null,
  drawProof: null,
};

describe("attachDrawProof", () => {
  it("attaches draw-proof metadata without mutating the source entry", () => {
    const proof = { roundId: "42", txHash: "txhash0001", proof: "digest-1", verified: true };
    const result = attachDrawProof(baseEntry, proof);
    expect(result.drawProof).toEqual(proof);
    expect(baseEntry.drawProof).toBeNull();
    expect(result).not.toBe(baseEntry);
  });
});

describe("hasProof", () => {
  it("returns false for entries with no proof", () => {
    expect(hasProof(baseEntry)).toBe(false);
    expect(hasProof({ ...baseEntry, drawProof: { roundId: "42", txHash: null, proof: null, verified: null } })).toBe(false);
  });

  it("returns true when a proof digest is present", () => {
    expect(hasProof({ ...baseEntry, drawProof: { roundId: "42", txHash: "tx", proof: "digest", verified: null } })).toBe(true);
  });
});

describe("verifyDrawProof", () => {
  it("resolves a won reward to claimed when proof and tx match the indexer", () => {
    const entry = attachDrawProof(baseEntry, { roundId: "42", txHash: "txhash0001", proof: "digest-1", verified: null });
    const { entry: updated, verdict } = verifyDrawProof(entry, { txHash: "txhash0001", proof: "digest-1" });
    expect(verdict.verdict).toBe("verified");
    expect(updated.status).toBe("claimed");
    expect(updated.drawProof?.verified).toBe(true);
  });

  it("keeps a won reward as won when verified but no claim tx exists yet", () => {
    const entry = attachDrawProof(baseEntry, { roundId: "42", txHash: null, proof: "digest-1", verified: null });
    const { entry: updated, verdict } = verifyDrawProof(entry, { txHash: null, proof: "digest-1" });
    expect(verdict.verdict).toBe("verified");
    expect(updated.status).toBe("won");
  });

  it("marks a missing proof as pending (missing flag)", () => {
    const noProof = { ...baseEntry, drawProof: null };
    const { entry: updated, verdict } = verifyDrawProof(noProof, { txHash: "txhash0001", proof: "digest-1" });
    expect(verdict.verdict).toBe("missing");
    expect(updated.status).toBe("pending");
  });

  it("marks a tx-hash mismatch as disputed", () => {
    const entry = attachDrawProof(baseEntry, { roundId: "42", txHash: "stored-tx", proof: "digest-1", verified: null });
    const { entry: updated, verdict } = verifyDrawProof(entry, { txHash: "indexer-tx", proof: "digest-1" });
    expect(verdict.verdict).toBe("invalid");
    expect(verdict).toMatchObject({ reason: "tx_mismatch" });
    expect(updated.status).toBe("disputed");
    expect(updated.drawProof?.verified).toBe(false);
  });

  it("marks a proof-digest mismatch as disputed", () => {
    const entry = attachDrawProof(baseEntry, { roundId: "42", txHash: "txhash0001", proof: "stored-digest", verified: null });
    const { entry: updated, verdict } = verifyDrawProof(entry, { txHash: "txhash0001", proof: "indexer-digest" });
    expect(verdict.verdict).toBe("invalid");
    expect(verdict).toMatchObject({ reason: "proof_mismatch" });
    expect(updated.status).toBe("disputed");
  });

  it("does not disturb a no_win outcome", () => {
    const entry = attachDrawProof({ ...baseEntry, status: "no_win" }, { roundId: "42", txHash: null, proof: "digest-1", verified: null });
    const { entry: updated, verdict } = verifyDrawProof(entry, { txHash: null, proof: "digest-1" });
    expect(verdict.verdict).toBe("missing"); // no tx observed => still pending via missing branch
    expect(updated.status).toBe("pending");
  });
});

describe("flagDisputed", () => {
  it("marks a previously valid entry as disputed with verified:false", () => {
    const entry = attachDrawProof(baseEntry, { roundId: "42", txHash: "txhash0001", proof: "digest-1", verified: true });
    const flagged = flagDisputed(entry);
    expect(flagged.status).toBe("disputed");
    expect(flagged.drawProof?.verified).toBe(false);
  });

  it("is a no-op safe on entries with no proof", () => {
    const flagged = flagDisputed(baseEntry);
    expect(flagged.status).toBe("disputed");
    expect(flagged.drawProof).toBeNull();
  });
});
