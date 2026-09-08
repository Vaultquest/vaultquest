import { describe, it, expect } from "vitest";
import {
  attachDrawProof,
  computeSnapshotHash,
  createEligibilitySnapshot,
  flagDisputed,
  hasProof,
  reproduceWinnerSelection,
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

  it("marks a snapshot-hash mismatch as disputed", () => {
    const entry = attachDrawProof(baseEntry, {
      roundId: "42",
      txHash: "txhash0001",
      proof: "digest-1",
      snapshotHash: "hash-stored-a",
      verified: null,
    });
    const { entry: updated, verdict } = verifyDrawProof(entry, {
      txHash: "txhash0001",
      proof: "digest-1",
      snapshotHash: "hash-indexer-b",
    });
    expect(verdict.verdict).toBe("invalid");
    expect(verdict).toMatchObject({ reason: "snapshot_mismatch" });
    expect(updated.status).toBe("disputed");
    expect(updated.drawProof?.verified).toBe(false);
  });

  it("successfully verifies when snapshot hash matches", () => {
    const entry = attachDrawProof(baseEntry, {
      roundId: "42",
      txHash: "txhash0001",
      proof: "digest-1",
      snapshotHash: "hash-matched",
      verified: null,
    });
    const { entry: updated, verdict } = verifyDrawProof(entry, {
      txHash: "txhash0001",
      proof: "digest-1",
      snapshotHash: "hash-matched",
    });
    expect(verdict.verdict).toBe("verified");
    expect(updated.status).toBe("claimed");
    expect(updated.drawProof?.verified).toBe(true);
    expect(updated.drawProof?.snapshotHash).toBe("hash-matched");
  });

  it("does not disturb a no_win outcome", () => {
    const entry = attachDrawProof({ ...baseEntry, status: "no_win" }, { roundId: "42", txHash: null, proof: "digest-1", verified: null });
    const { entry: updated, verdict } = verifyDrawProof(entry, { txHash: null, proof: "digest-1" });
    expect(verdict.verdict).toBe("missing");
    expect(updated.status).toBe("pending");
  });
});

describe("createEligibilitySnapshot and computeSnapshotHash", () => {
  it("produces deterministic hash invariant under participant input order", () => {
    const entriesA = [
      { participant: "GBALICE", balance: "1000" },
      { participant: "GBBOB", balance: "2000" },
    ];
    const entriesB = [
      { participant: "GBBOB", balance: "2000" },
      { participant: "GBALICE", balance: "1000" },
    ];

    const snapshotA = createEligibilitySnapshot(1, 100, 1000, entriesA);
    const snapshotB = createEligibilitySnapshot(1, 100, 1000, entriesB);

    expect(snapshotA.snapshotHash).toBe(snapshotB.snapshotHash);
    expect(computeSnapshotHash(snapshotA)).toBe(snapshotA.snapshotHash);
    expect(snapshotA.totalEligible).toBe("3000");
  });

  it("ensures late deposits after snapshot cutoff do not alter past round snapshot", () => {
    const originalEntries = [
      { participant: "GBALICE", balance: "1000" },
      { participant: "GBBOB", balance: "2000" },
    ];
    const snapshot = createEligibilitySnapshot(1, 100, 1000, originalEntries);

    const postCutoffEntries = [
      ...originalEntries,
      { participant: "GBCHARLIE", balance: "5000" },
    ];

    expect(snapshot.totalEligible).toBe("3000");
    expect(snapshot.entries.length).toBe(2);

    const newSnapshot = createEligibilitySnapshot(2, 200, 2000, postCutoffEntries);
    expect(newSnapshot.snapshotHash).not.toBe(snapshot.snapshotHash);
    expect(newSnapshot.totalEligible).toBe("8000");
  });
});

describe("reproduceWinnerSelection", () => {
  it("deterministically selects winner based on proportional cumulative weights", () => {
    const entries = [
      { participant: "GBALICE", balance: "1000" },
      { participant: "GBBOB", balance: "2000" },
    ];
    const snapshot = createEligibilitySnapshot(1, 100, 1000, entries);

    const winnerAtZero = reproduceWinnerSelection(snapshot, 0n);
    expect(winnerAtZero).toBe("GBALICE");

    const winnerAt1500 = reproduceWinnerSelection(snapshot, 1500n);
    expect(winnerAt1500).toBe("GBBOB");
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
