# Rent-aware TTL management and verifiable archival (#35)

Soroban charges rent to keep persistent entries alive and archives entries whose
TTL lapses. Leaving survival to chance risks an active deposit, claim, or
governance record expiring, or an attacker inflating rent by forcing bumps.
`contracts/drip-pool/src/ttl.rs` gives every key an explicit policy, bumps TTLs
in bounded steps, sweeps in checkpointed batches that are safe to retry, and
commits settled history to a hash-chained archive that anyone can verify.

The module is the pure decision layer (no `Env` except `sha256` for the hash
chain), so it unit-tests fast and deterministically. A sweeper — an on-chain
entrypoint or an off-chain job — feeds it each key's class and remaining TTL and
applies the returned action via `extend_ttl`.

## Key classification

Every key has an owner class fixing its minimum TTL, bump target, and archive
rule (`policy_for`, a fixed constant table so the rent posture is auditable in
one place):

| Class | Min TTL | Extend to | Archived | Examples |
|---|---|---|---|---|
| `ActiveCritical` | 90 d | 180 d | no | live deposits, claims, governance |
| `Pending` | 14 d | 30 d | yes | withdrawal requests, open proposals |
| `Historical` | 7 d | 14 d | yes | settled records kept for audit |
| `Reconstructible` | 1 d | 3 d | no | caches derivable from other state |

`ActiveCritical` never expires under the SLO because the sweeper bumps it back to
180 days whenever it drops below the 90-day floor.

## Bounded extensions, no rent exhaustion

`decide(policy, remaining_ttl)` returns `Skip` / `Extend` / `Archive` purely from
policy and remaining life. Every extension is clamped to `MAX_EXTENSION_LEDGERS`
(400 days), so no caller — trusted or not — can lock in unbounded rent in one
step. `is_auto_bumpable` gates which classes the automatic sweeper may bump at
all: there is no path for an arbitrary or untrusted key to draw rent, which is
what stops rent-exhaustion abuse. Because `extend_ttl` only ever raises TTL,
`Extend` is idempotent, so a crashed sweep that re-runs a key is safe.

## Checkpointed batch sweeper

`plan_batch(total_keys, cursor, max_entries)` plans the next batch as a half-open
index range bounded by `max_entries`, so a single transaction never exceeds its
resource budget however large the key set grows. The persisted `SweepCursor`
resumes across transactions; reaching the end wraps to the start and counts a
completed pass, making the sweep a perpetual, self-resuming loop. The plan is a
pure function of `(total, cursor, budget)`, so a **duplicated or retried** sweep
re-plans the same range and repeats work rather than skipping keys.

`is_sweep_stale(ledgers_since_last_pass, tightest_min_ttl)` is the alert that must
fire *before* recovery becomes impossible: if a full pass has not completed
within the tightest class's min TTL, an active entry could expire, so the sweep
is escalated.

## Verifiable archive

Settled history is folded into a hash chain rooted at `archive_genesis`:
`archive_fold(root, record_hash)` appends a record, producing a new root bound to
the entire prior history. `archive_verify` recomputes the root from a sequence of
record hashes, so archive integrity is **independently verifiable** — a single
altered or reordered record changes the root. `archive_contains_at` proves a
specific record sat at a specific position, which is the basis for
reconstruction: a restore tool replays the archived records, checking each
against the committed root before trusting it.

## Tests

`ttl.rs` carries 12 unit tests: SLO-floor bumping, extension clamping,
rent-exhaustion rejection, entry-bounded batching, cursor wrap and pass counting,
retry/duplicate safety, staleness escalation, and archive fold / verify /
tamper-detection / position proofs.
