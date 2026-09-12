# Eligibility snapshots

Prize draws have to be reproducible by someone who was not watching. A tie
between a deposit, a round close and a winner is only checkable if the set of
eligible balances at the cutoff is pinned, hashed, and then never changes.

Code: `stellar-wallet-connect/src/vault/lib/eligibility-snapshot.ts`
Tests: `stellar-wallet-connect/src/vault/lib/eligibility-snapshot.test.ts`

## Cutoff rule

The rule is stated here because it is the part that settles arguments later.

| Situation | Eligible | Reason code |
|---|---|---|
| Confirmed deposit before the cutoff | yes | `eligible` |
| Confirmed deposit **exactly at** the cutoff | **yes** | `eligible` |
| Confirmed deposit after the cutoff | no | `late` |
| `pending` or `failed` deposit | no | `unconfirmed` |
| Timestamp that cannot be parsed | no | `invalid_timestamp` |

Including the exact cutoff instant is a deliberate choice: the snapshot is taken
*at* the close, so the close itself counts. Moving that boundary changes who is
eligible in a dispute, so it is a decision to make once, in writing, and not a
detail to discover from code.

An unparsable timestamp is excluded rather than treated as old. The failure mode
that protects against is a malformed row earning eligibility by accident.

## Schema

```json
{
  "schemaVersion": "eligibility-snapshot.v1",
  "roundId": "round-42",
  "cutoffAt": "2026-09-13T00:00:00.000Z",
  "entries": [
    { "address": "gbbd47if...", "amount": "100.0000000", "depositAt": "2026-09-12T00:00:00.000Z" }
  ],
  "entryCount": 1,
  "totalAmount": "100.0000000",
  "hash": "sha256:..."
}
```

- addresses are lowercased - Stellar public keys are case-insensitive, and a
  hash cannot be, so normalization happens once, here;
- entries are sorted by address, so the order a caller collected them in cannot
  change the hash;
- amounts are decimal strings at stroop precision, and the total is summed in
  `BigInt` stroops, so `0.1` + `0.2` is `0.3000000` and never a float artifact;
- the schema is versioned, so a reference can say which shape it committed to.

## Hash

`hash` is SHA-256 over a canonical line-based payload, not over
`JSON.stringify` of the caller's object:

```text
eligibility-snapshot.v1
<roundId>
<cutoffAt>
<address>|<amount>|<depositAt>   (sorted by address, one line per entry)
```

That choice is the point: key order and entry order are properties of whatever
code built the object, and a digest has to depend on the set, not on the
construction. Two contributors who agree on who was eligible get the same hash.

`verifySnapshotHash(snapshot)` recomputes the digest from a snapshot's own
contents. A snapshot whose hash no longer matches has been edited, and a draw
proof referencing it should be treated as disputed rather than trusted.

`diffEligibilitySnapshots(before, after)` returns `added`, `removed` and `changed`
addresses. For a closed round the expected result is empty on all three: a late
deposit rebuilds an identical snapshot because the cutoff rule excludes it, and
anything showing up under `added` means a round was reopened.

## How this connects to a draw proof

A draw proof today carries the round id, the claim transaction hash and a proof
digest (`DrawProof`, #175). The snapshot is what a proof should reference
next to that digest:

1. build the snapshot at the close and store `hash` with the round;
2. when a claim is verified, recompute the snapshot from the archive and check
   the hash still matches before the proof is accepted;
3. if the hash differs, the eligibility set changed after the close, which is a
   `disputed` outcome rather than a verified one.

Wiring step 2 into `verifyDrawProof` is deliberately not part of this module: that
function already decides `verified`/`missing`/`invalid` from the indexer snapshot, and
extending its verdict logic is a separate change with its own review.

## Test coverage

The suite pins each branch rather than the happy path: exact-cutoff inclusion,
one-millisecond-late exclusion, pending and failed exclusion, unparsable
timestamps, stroop totals, amount normalization, hash stability across input
order and rebuilds, a late deposit leaving a closed round byte-identical, a
reopened round showing up as `added`, order independence of the canonical payload,
and tamper detection for both an edited amount and an appended entry.
