# Prize Draw Auditability & Immutable Eligibility Snapshots

This document specifies the technical architecture and audit guarantees for verifiable prize draws in VaultQuest as implemented in Issue #172.

## Problem Statement

Prior to this implementation, prize draws calculated winner selection from participant balances at the moment of draw execution without archiving an immutable, cryptographically verifiable snapshot of eligible participants. Furthermore, audit mechanisms needed deterministic guarantees that:
1. Every draw proof references an immutable eligibility snapshot recorded on-chain.
2. Late deposits completed after a round's cutoff ledger cannot alter eligibility or payout outcomes of closed rounds.
3. Boundary conditions (exact cutoff ledger, in-flight/pending deposits during draw commitment, and post-finalization late deposits) are strictly enforced.

## On-Chain Architecture (`contracts/drip-pool`)

### 1. Data Structures

#### `EligibilityEntry`
Represents an eligible participant's balance frozen at the cutoff ledger:
```rust
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EligibilityEntry {
    pub participant: Address,
    pub balance: i128,
}
```

#### `EligibilitySnapshot`
Persistent record archived under `DataKey::DrawSnapshot(round_id)`:
```rust
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EligibilitySnapshot {
    pub round_id: u32,
    pub cutoff_ledger: u32,
    pub cutoff_time: u64,
    pub total_eligible: i128,
    pub entries: Vec<EligibilityEntry>,
    pub snapshot_hash: BytesN<32>,
}
```

#### `Draw` Record Extension
The `Draw` struct references the snapshot hash:
```rust
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Draw {
    pub round_id: u32,
    pub commit_hash: BytesN<32>,
    pub freeze_ledger: u32,
    pub status: DrawStatus,
    pub winner: Option<Address>,
    pub prize_amount: i128,
    pub snapshot_hash: Option<Bytes>,
}
```

### 2. Canonical Deterministic Hashing

To guarantee domain separation and invariant snapshot hashes regardless of input slice ordering:
1. Only participants with non-zero deposited balances are included.
2. Entries are deterministically sorted by their canonical XDR representation (`entry.participant.clone().to_xdr(env)`).
3. The SHA-256 digest is calculated over:
   - Domain separator: `b"VAULTQUEST_ELIGIBILITY_V1"`
   - `round_id` (4 bytes big-endian)
   - `cutoff_ledger` (4 bytes big-endian)
   - `cutoff_time` (8 bytes big-endian)
   - `total_eligible` (16 bytes big-endian)
   - `entries.len()` (4 bytes big-endian)
   - For each entry: participant XDR bytes + balance (16 bytes big-endian)

### 3. State Invariants and Boundary Enforcement

| Scenario | State / Boundary | Behavior |
| :--- | :--- | :--- |
| **Exact Cutoff** | `ledger <= freeze_ledger` | Deposits are credited to participant balance and included in the round snapshot. |
| **In-Flight / Pending** | `commit_draw` executed | Any `join` or `deposit` during `DrawStatus::Committed` reverts with `Error::DrawActive`. |
| **Late Deposit** | `finalize_draw` completed | Depositor joins/deposits for future rounds. Past round `EligibilitySnapshot` remains immutable. |

### 4. Events & Views

#### Event Emission
```rust
env.events().publish(
    (symbol_short!("draw"), symbol_short!("snapshot")),
    (draw.round_id, snapshot_hash, draw.freeze_ledger, total_eligible),
);
```

#### Public Contract Views
- `get_draw(env) -> Result<Draw, Error>`: Returns active/last draw record including `snapshot_hash`.
- `get_draw_snapshot(env, round_id: u32) -> Result<EligibilitySnapshot, Error>`: Returns full snapshot payload.
- `get_snapshot_hash(env, round_id: u32) -> Result<BytesN<32>, Error>`: Returns 32-byte snapshot hash.

---

## Client & Off-Chain Verification (`stellar-wallet-connect`)

### Verification Pipeline
The TypeScript client verifies draw proofs and snapshot hashes against on-chain/indexer observations:
```typescript
export interface DrawProofIndexerSnapshot {
  txHash: string | null;
  proof: string | null;
  snapshotHash?: string | null;
}

export function verifyDrawProof(
  entry: RewardHistoryEntry,
  indexer: DrawProofIndexerSnapshot,
): { entry: RewardHistoryEntry; verdict: ProofVerdict };
```

- **Hash Match**: Resolves winning entries to `claimed` or `won`, setting `verified: true`.
- **Snapshot Mismatch**: Flags entry as `disputed` with reason `snapshot_mismatch`.
- **Late Deposit Invariance**: Confirms historical snapshot digests remain unaffected by post-cutoff state changes.

### Exported Verification Utilities
- `createEligibilitySnapshot`: Deterministically builds snapshot and calculates hash.
- `computeSnapshotHash`: Canonical SHA-256 hash computation over sorted entries.
- `reproduceWinnerSelection`: Deterministically reproduces proportional winner selection for auditors.
