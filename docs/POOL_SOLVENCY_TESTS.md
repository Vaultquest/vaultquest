# Pool solvency: state-machine property tests and fuzzing (#33)

Example tests cannot cover adversarial sequences of joins, deposits, claims,
withdrawals, pauses, and ledger time. This adds an implementation-independent
reference model plus generated command sequences that exercise the drip pool's
solvency-critical entrypoints and assert invariants after every step.

Lives in `contracts/drip-pool/src/model.rs` (the model) and
`contracts/drip-pool/src/model_test.rs` (the generators, differential harness,
and seeded traces).

## How it works

`model.rs` is a pure `std`-side model of the pool's observable state and the
outcome of every modelled entrypoint — no `Env`, no storage, no auth. It is an
independent oracle, mirroring the contract's accounting including its quirks
(`total_deposited`/`total_drips` as lifetime counters, `deposit` auto-creating a
participant, one-time `withdraw`).

`model_test.rs` generates a constrained sequence of commands across four actors
and ledger time, and replays each command against **both** the model and the
real `DripPool` contract. After every step it asserts:

1. **Agreement** — the model and contract agree on accept/reject and on the
   returned value.
2. **Rejected calls leave state unchanged** — after any rejected call the
   contract's observable state is byte-for-byte identical to before it.
3. **Invariants on real state** — checked against the contract, not just the
   model: conservation (`total_deposited` tracks the accepted deposits),
   non-negative balances, `claimable <= deposited`, multiplier within its tier
   bounds, reentrancy lock released, and a never-empty admin set.

proptest shrinks any failure to a minimal command sequence and prints the seed,
so a red run reproduces deterministically.

## Budgets

The default case count is small enough for PR CI. proptest reads `PROPTEST_CASES`
automatically, so a nightly job runs the same tests far deeper:

```
PROPTEST_CASES=20000 cargo test -p drip-pool solvency
```

## Seeded regressions

Dedicated traces pin the required cases: repeated claim (pays once), lock expiry,
signer rotation, one-time withdrawal, and arithmetic overflow (`deposit` near
`i128::MAX` is rejected with `MathOverflow` and leaves state unchanged — the
guard the model surfaced).

## What the model found

Building the model against the contract surfaced two real issues, both fixed:

- `deposit` accounting used unchecked `i128` addition; it now uses `checked_add`
  returning `MathOverflow`, so a deposit can never silently wrap a participant's
  principal or the pool total.
- `withdraw` reads `Pool` for its reentrancy lock, so a participant who joined a
  never-created pool cannot withdraw (`NotInitialized`) — after the `NotJoined`
  and `LockupActive` checks. The model now encodes that exact error precedence.

## Scope

The randomized model covers the balance/solvency entrypoints — create, join,
deposit, deposit_with_duration, claim, withdraw — plus admin add/remove and the
PRNG `draw_winner`. The multi-step commit/reveal raffle (`commit_draw` /
`finalize_draw` / `cancel_draw`) and the timelocked proposal flow are their own
state machines with dedicated tests in `test.rs`.
