/**
 * Draw-proof helpers for VaultQuest reward history (#175).
 *
 * A draw proof ties each reward entry to its originating prize draw: the draw
 * round id, the on-chain claim transaction hash, and a proof digest that can be
 * compared against authoritative transaction/indexer data. The helpers here are
 * pure so the proof lifecycle — attach → verify → flag — can be unit-tested
 * without a live network.
 *
 * `verifyDrawProof` compares an entry against an indexer-observed snapshot and
 * derives the reward's *final* status from the verdict. Entries with a missing
 * or mismatched proof resolve to `pending`/`disputed` so the UI never presents
 * an unverified claim as final.
 */

import crypto from "crypto";
import type {
  DrawProof,
  EligibilitySnapshot,
  EligibilitySnapshotEntry,
  RewardHistoryEntry,
  RewardOutcome,
} from "../contract/types";

/**
 * A snapshot of the authoritative on-chain/indexer observation for a reward,
 * used as the source of truth when verifying a draw proof.
 */
export interface DrawProofIndexerSnapshot {
  /** The claim transaction hash observed on-chain for this reward. */
  txHash: string | null;
  /** The draw proof digest observed by the indexer. */
  proof: string | null;
  /** Authoritative snapshot hash recorded on-chain at cutoff (#172). */
  snapshotHash?: string | null;
}

/** Result of verifying an entry's draw proof against indexer data. */
export type ProofVerdict =
  | { verdict: "verified" }
  | { verdict: "missing"; reason: "no_proof" | "no_tx" | "no_snapshot" }
  | { verdict: "invalid"; reason: "tx_mismatch" | "proof_mismatch" | "snapshot_mismatch" };

/**
 * Attach draw-proof metadata to a reward entry. Returns a new (immutable) entry
 * with `drawProof` set; the caller owns status reconciliation.
 */
export function attachDrawProof(
  entry: RewardHistoryEntry,
  drawProof: DrawProof,
): RewardHistoryEntry {
  return { ...entry, drawProof };
}

/**
 * Computes a canonical, deterministic SHA-256 hash for an eligibility snapshot.
 */
export function computeSnapshotHash(
  snapshot: Omit<EligibilitySnapshot, "snapshotHash">,
): string {
  const sortedEntries = [...snapshot.entries].sort((a, b) =>
    a.participant.localeCompare(b.participant),
  );
  const payload = [
    "VAULTQUEST_ELIGIBILITY_V1",
    String(snapshot.roundId),
    String(snapshot.cutoffLedger),
    String(snapshot.cutoffTime),
    String(snapshot.totalEligible),
    String(sortedEntries.length),
    ...sortedEntries.map((e) => `${e.participant}:${e.balance}`),
  ].join("|");
  return crypto.createHash("sha256").update(payload).digest("hex");
}

/**
 * Creates an immutable eligibility snapshot at a given round and cutoff ledger.
 */
export function createEligibilitySnapshot(
  roundId: number | string,
  cutoffLedger: number,
  cutoffTime: number,
  entries: EligibilitySnapshotEntry[],
): EligibilitySnapshot {
  const sortedEntries = [...entries]
    .filter((e) => BigInt(e.balance) > 0n)
    .sort((a, b) => a.participant.localeCompare(b.participant));
  const totalEligible = sortedEntries
    .reduce((sum, e) => sum + BigInt(e.balance), 0n)
    .toString();

  const partial = {
    roundId,
    cutoffLedger,
    cutoffTime,
    totalEligible,
    entries: sortedEntries,
  };
  return {
    ...partial,
    snapshotHash: computeSnapshotHash(partial),
  };
}

/**
 * Deterministically reproduces winner selection given a verified snapshot and random value.
 */
export function reproduceWinnerSelection(
  snapshot: EligibilitySnapshot,
  randomVal: bigint,
): string {
  const eligible = snapshot.entries.filter((e) => BigInt(e.balance) > 0n);
  if (eligible.length === 0) {
    throw new Error("No eligible participants in snapshot");
  }
  let currentSum = 0n;
  for (const entry of eligible) {
    currentSum += BigInt(entry.balance);
    if (currentSum > randomVal) {
      return entry.participant;
    }
  }
  return eligible[0].participant;
}

/**
 * Verify an entry's draw proof against an authoritative indexer snapshot and
 * return the normalized outcome plus the underlying verdict.
 */
export function verifyDrawProof(
  entry: RewardHistoryEntry,
  indexer: DrawProofIndexerSnapshot,
): { entry: RewardHistoryEntry; verdict: ProofVerdict } {
  const proof = entry.drawProof;

  let verdict: ProofVerdict;
  if (!proof || !proof.proof) {
    verdict = { verdict: "missing", reason: "no_proof" };
  } else if (indexer.txHash !== null && proof.txHash !== null && indexer.txHash !== proof.txHash) {
    verdict = { verdict: "invalid", reason: "tx_mismatch" };
  } else if (indexer.proof !== null && indexer.proof !== proof.proof) {
    verdict = { verdict: "invalid", reason: "proof_mismatch" };
  } else if (
    indexer.snapshotHash !== undefined &&
    proof.snapshotHash !== undefined &&
    indexer.snapshotHash !== null &&
    proof.snapshotHash !== null &&
    indexer.snapshotHash !== proof.snapshotHash
  ) {
    verdict = { verdict: "invalid", reason: "snapshot_mismatch" };
  } else if (!indexer.txHash && !proof.txHash) {
    if (entry.status === "won") {
      verdict = { verdict: "verified" };
    } else {
      verdict = { verdict: "missing", reason: "no_tx" };
    }
  } else {
    verdict = { verdict: "verified" };
  }

  return {
    verdict,
    entry: {
      ...entry,
      drawProof: proof
        ? {
            roundId: proof.roundId,
            txHash: proof.txHash,
            proof: proof.proof,
            verified: verdict.verdict === "verified",
            snapshotHash: proof.snapshotHash ?? null,
            snapshot: proof.snapshot ?? null,
          }
        : null,
      txHash: proof?.txHash ?? entry.txHash,
      status: outcomeFor(entry.status, verdict, proof?.txHash ?? null),
    },
  };
}

/**
 * Flag an entry whose proof was found to not reconcile with the indexer. Keeps
 * the entry visible in history but surfaces it as disputed for investigation.
 */
export function flagDisputed(entry: RewardHistoryEntry): RewardHistoryEntry {
  return {
    ...entry,
    drawProof: entry.drawProof
      ? { ...entry.drawProof, verified: false }
      : entry.drawProof,
    status: "disputed",
  };
}

/**
 * True when the entry carries a proof digest (not just a round id) that can be
 * verified. Used to flag missing proof in the UI before reconciliation.
 */
export function hasProof(entry: RewardHistoryEntry): boolean {
  return Boolean(entry.drawProof?.proof);
}

function outcomeFor(
  base: RewardOutcome,
  verdict: ProofVerdict,
  txHash: string | null,
): RewardOutcome {
  if (verdict.verdict === "invalid") return "disputed";
  if (verdict.verdict === "missing") return "pending";
  if (base === "won" && txHash) return "claimed";
  return base;
}
