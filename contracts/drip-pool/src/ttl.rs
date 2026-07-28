//! #35 Rent-aware TTL management and verifiable state archival.
//!
//! Soroban charges rent to keep persistent entries alive and archives entries
//! whose TTL lapses. Leaving survival to chance risks an active deposit or
//! governance record expiring, or an attacker inflating rent by forcing bumps.
//! This module gives every key an explicit policy, bumps TTLs in bounded steps,
//! sweeps in checkpointed batches that are safe to retry, and commits settled
//! history to a hash-chained archive that anyone can verify and reconstruct
//! from.
//!
//! The logic here is pure (no `Env`) wherever it can be, so it unit-tests fast
//! and deterministically; the hash chain takes an `Env` only for `sha256`. It
//! is the decision layer: a sweeper (on-chain entrypoint or off-chain job)
//! feeds it each key's class and remaining TTL and applies the returned
//! `TtlAction` via `extend_ttl`, walking keys in the bounded batches that
//! `plan_batch` checkpoints, and folding settled records into the archive root
//! that `archive_verify` later checks.

use soroban_sdk::{contracttype, BytesN, Env};

/// How a persistent key earns its keep. The class fixes the key's minimum TTL,
/// its bump target, and whether it is archived before it may expire.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyClass {
    /// Live deposits, claims, governance. Must never expire under the SLO.
    ActiveCritical,
    /// In-flight work (withdrawal requests, open proposals). Bounded life.
    Pending,
    /// Settled records kept for audit. Archived, then allowed to expire.
    Historical,
    /// Caches derivable from other state. Cheapest; may lapse freely.
    Reconstructible,
}

/// Ledgers per day at ~5s/ledger, the unit the SLO windows are quoted in.
pub const LEDGERS_PER_DAY: u32 = 17_280;

/// Hard ceiling on any single extension. A bump can never target more than this
/// many ledgers of life, so no caller — trusted or not — can lock in unbounded
/// rent or push an entry's archival past the horizon in one step.
pub const MAX_EXTENSION_LEDGERS: u32 = 400 * LEDGERS_PER_DAY;

/// The rent rule for a class: never let live TTL fall below `min_ttl`, and when
/// bumping, raise it to `extend_to` (clamped to `MAX_EXTENSION_LEDGERS`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TtlPolicy {
    pub class: KeyClass,
    pub min_ttl: u32,
    pub extend_to: u32,
    pub archive: bool,
}

/// The fixed policy table. Constants, not per-call inputs, so the rent posture
/// of the contract is auditable in one place and cannot be talked up by a
/// caller supplying its own numbers.
pub const fn policy_for(class: KeyClass) -> TtlPolicy {
    match class {
        KeyClass::ActiveCritical => TtlPolicy {
            class,
            min_ttl: 90 * LEDGERS_PER_DAY,
            extend_to: 180 * LEDGERS_PER_DAY,
            archive: false,
        },
        KeyClass::Pending => TtlPolicy {
            class,
            min_ttl: 14 * LEDGERS_PER_DAY,
            extend_to: 30 * LEDGERS_PER_DAY,
            archive: true,
        },
        KeyClass::Historical => TtlPolicy {
            class,
            min_ttl: 7 * LEDGERS_PER_DAY,
            extend_to: 14 * LEDGERS_PER_DAY,
            archive: true,
        },
        KeyClass::Reconstructible => TtlPolicy {
            class,
            min_ttl: LEDGERS_PER_DAY,
            extend_to: 3 * LEDGERS_PER_DAY,
            archive: false,
        },
    }
}

/// What to do with a key at the current ledger, decided purely from its policy
/// and remaining life.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TtlAction {
    /// Enough life remains; leave it (idempotent no-op on a re-run).
    Skip,
    /// Bump the TTL so it lives for `extend_to` more ledgers (clamped).
    Extend { threshold: u32, extend_to: u32 },
    /// Past its keep window and archivable: archive, then let it expire.
    Archive,
}

/// Decide the action for one key given how many ledgers of life it has left.
///
/// The decision is a pure function of policy and remaining life, so a crashed
/// sweep that re-runs the same key reaches the same conclusion — `Extend` is
/// idempotent because Soroban's `extend_ttl` only ever raises TTL, and a second
/// `Extend` on an already-bumped entry does nothing.
pub fn decide(policy: &TtlPolicy, remaining_ttl: u32) -> TtlAction {
    if remaining_ttl >= policy.min_ttl {
        return TtlAction::Skip;
    }
    if policy.archive && remaining_ttl == 0 {
        return TtlAction::Archive;
    }
    TtlAction::Extend {
        threshold: policy.min_ttl,
        extend_to: policy.extend_to.min(MAX_EXTENSION_LEDGERS),
    }
}

/// Whether a class may be bumped by the automatic sweeper at all. Only the
/// contract's own approved classes qualify; there is no path for an arbitrary
/// or untrusted key to draw rent, which is what stops rent-exhaustion abuse.
pub const fn is_auto_bumpable(class: KeyClass) -> bool {
    matches!(
        class,
        KeyClass::ActiveCritical | KeyClass::Pending | KeyClass::Historical
    )
}

// ── Checkpointed batch sweeper ──────────────────────────────────────────────

/// Sweep progress, persisted between calls so a large key set is processed
/// across many bounded transactions without losing its place.
#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct SweepCursor {
    /// Next key index to process.
    pub next_index: u32,
    /// Keys processed since the sweep started, for metrics/alerts.
    pub processed: u32,
    /// Times a full pass has completed, so staleness can be alerted on.
    pub passes: u32,
}

/// One planned batch: the half-open index range to process and the cursor to
/// persist afterwards.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SweepPlan {
    pub start: u32,
    pub end: u32,
    pub next: SweepCursor,
    /// True when this batch finishes a full pass over the key set.
    pub completed_pass: bool,
}

/// Plan the next batch. Entry-bounded by `max_entries` so a single transaction
/// can never exceed its resource budget however large the key set grows. When
/// the cursor reaches the end it wraps to the start and counts a completed pass,
/// so sweeping is a perpetual, self-resuming loop.
///
/// Re-running with the *same* input cursor re-plans the *same* range: the plan
/// is a pure function of (total, cursor, budget), so a retried or duplicated
/// sweep repeats work rather than skipping keys.
pub fn plan_batch(total_keys: u32, cursor: SweepCursor, max_entries: u32) -> SweepPlan {
    if total_keys == 0 || max_entries == 0 {
        return SweepPlan {
            start: 0,
            end: 0,
            next: cursor,
            completed_pass: false,
        };
    }
    let start = cursor.next_index.min(total_keys);
    let end = start.saturating_add(max_entries).min(total_keys);
    let count = end - start;
    let reached_end = end >= total_keys;

    let next = SweepCursor {
        next_index: if reached_end { 0 } else { end },
        processed: cursor.processed.saturating_add(count),
        passes: cursor.passes.saturating_add(u32::from(reached_end)),
    };
    SweepPlan {
        start,
        end,
        next,
        completed_pass: reached_end,
    }
}

/// Ledgers since the last completed pass, for the alert that must fire *before*
/// recovery becomes impossible. Compared against a class's `min_ttl` by the
/// caller: if a full sweep hasn't completed within the tightest min_ttl, active
/// entries are at risk and the sweep is falling behind.
pub fn is_sweep_stale(ledgers_since_last_pass: u32, tightest_min_ttl: u32) -> bool {
    ledgers_since_last_pass >= tightest_min_ttl
}

// ── Hash-chained archive ────────────────────────────────────────────────────

/// The genesis root of an empty archive: 32 zero bytes.
pub fn archive_genesis(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0u8; 32])
}

/// Fold one record into the archive root: `root' = sha256(root || record)`.
///
/// The new root commits to the entire ordered history, so a single stored
/// 32-byte root makes the whole archive tamper-evident: changing, dropping, or
/// reordering any past record changes the root.
pub fn archive_fold(env: &Env, root: &BytesN<32>, record_hash: &BytesN<32>) -> BytesN<32> {
    let mut buf = [0u8; 64];
    buf[..32].copy_from_slice(&root.to_array());
    buf[32..].copy_from_slice(&record_hash.to_array());
    let input = soroban_sdk::Bytes::from_array(env, &buf);
    env.crypto().sha256(&input).into()
}

/// Recompute the root over an ordered list of record hashes and check it
/// against the claimed root. This is the independent verification the archive
/// promises: given the records, anyone can prove the stored root is honest.
pub fn archive_verify(
    env: &Env,
    records: &soroban_sdk::Vec<BytesN<32>>,
    claimed_root: &BytesN<32>,
) -> bool {
    let mut root = archive_genesis(env);
    for r in records.iter() {
        root = archive_fold(env, &root, &r);
    }
    &root == claimed_root
}

/// Verify that `record` sits at `index` in the archive by replaying the chain
/// up to and including it and confirming the running root matches the stored
/// checkpoint captured at that point. This is what restore/reconstruction
/// tooling calls to trust an archived record before rehydrating it.
pub fn archive_contains_at(
    env: &Env,
    records: &soroban_sdk::Vec<BytesN<32>>,
    index: u32,
    record: &BytesN<32>,
    root_after: &BytesN<32>,
) -> bool {
    if index >= records.len() || &records.get_unchecked(index) != record {
        return false;
    }
    let mut root = archive_genesis(env);
    for i in 0..=index {
        root = archive_fold(env, &root, &records.get_unchecked(i));
    }
    &root == root_after
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{vec, Env};

    #[test]
    fn active_critical_never_skips_below_slo() {
        let p = policy_for(KeyClass::ActiveCritical);
        // With one day of life left, well under the 90-day floor, it must bump.
        assert!(matches!(
            decide(&p, LEDGERS_PER_DAY),
            TtlAction::Extend { .. }
        ));
        // Comfortably above the floor, it is left alone.
        assert_eq!(decide(&p, 120 * LEDGERS_PER_DAY), TtlAction::Skip);
    }

    #[test]
    fn extension_is_clamped_to_the_ceiling() {
        let mut p = policy_for(KeyClass::ActiveCritical);
        p.extend_to = u32::MAX;
        match decide(&p, 0) {
            TtlAction::Extend { extend_to, .. } => assert_eq!(extend_to, MAX_EXTENSION_LEDGERS),
            other => panic!("expected Extend, got {other:?}"),
        }
    }

    #[test]
    fn historical_archives_only_when_fully_lapsed() {
        let p = policy_for(KeyClass::Historical);
        assert_eq!(decide(&p, 0), TtlAction::Archive);
        // Still some life but under the floor: extend rather than archive early.
        assert!(matches!(decide(&p, 1), TtlAction::Extend { .. }));
    }

    #[test]
    fn reconstructible_is_not_auto_bumpable() {
        // Rent-exhaustion guard: caches are never bumped by the sweeper.
        assert!(!is_auto_bumpable(KeyClass::Reconstructible));
        assert!(is_auto_bumpable(KeyClass::ActiveCritical));
        assert!(is_auto_bumpable(KeyClass::Pending));
        assert!(is_auto_bumpable(KeyClass::Historical));
    }

    #[test]
    fn decide_is_idempotent_on_a_bumped_entry() {
        let p = policy_for(KeyClass::Pending);
        // After a bump the entry has `extend_to` life, which is >= min_ttl, so a
        // re-run skips — the property that makes a retried sweep safe.
        assert_eq!(decide(&p, p.extend_to), TtlAction::Skip);
    }

    #[test]
    fn batches_are_entry_bounded_and_resume() {
        let c0 = SweepCursor::default();
        let p1 = plan_batch(250, c0, 100);
        assert_eq!((p1.start, p1.end), (0, 100));
        assert!(!p1.completed_pass);

        let p2 = plan_batch(250, p1.next, 100);
        assert_eq!((p2.start, p2.end), (100, 200));

        let p3 = plan_batch(250, p2.next, 100);
        assert_eq!((p3.start, p3.end), (200, 250));
        assert!(p3.completed_pass);
        assert_eq!(p3.next.passes, 1);
        assert_eq!(p3.next.next_index, 0); // wrapped

        assert_eq!(p3.next.processed, 250);
    }

    #[test]
    fn replanning_the_same_cursor_repeats_the_same_range() {
        // Idempotency / crash-safety: same inputs -> same batch, so a retried
        // sweep never skips a key.
        let c = SweepCursor {
            next_index: 40,
            processed: 40,
            passes: 0,
        };
        assert_eq!(plan_batch(100, c, 25), plan_batch(100, c, 25));
    }

    #[test]
    fn empty_or_zero_budget_is_a_noop() {
        let c = SweepCursor::default();
        assert_eq!(plan_batch(0, c, 100).next, c);
        assert_eq!(plan_batch(100, c, 0).next, c);
    }

    #[test]
    fn staleness_alerts_before_the_tightest_floor() {
        let floor = policy_for(KeyClass::Reconstructible).min_ttl;
        assert!(!is_sweep_stale(floor - 1, floor));
        assert!(is_sweep_stale(floor, floor));
    }

    #[test]
    fn archive_root_commits_to_history_and_verifies() {
        let env = Env::default();
        let a = BytesN::from_array(&env, &[1u8; 32]);
        let b = BytesN::from_array(&env, &[2u8; 32]);
        let c = BytesN::from_array(&env, &[3u8; 32]);

        let mut root = archive_genesis(&env);
        root = archive_fold(&env, &root, &a);
        root = archive_fold(&env, &root, &b);
        root = archive_fold(&env, &root, &c);

        let records = vec![&env, a.clone(), b.clone(), c.clone()];
        assert!(archive_verify(&env, &records, &root));
    }

    #[test]
    fn archive_detects_tampering() {
        let env = Env::default();
        let a = BytesN::from_array(&env, &[1u8; 32]);
        let b = BytesN::from_array(&env, &[2u8; 32]);
        let tampered = BytesN::from_array(&env, &[9u8; 32]);

        let mut root = archive_genesis(&env);
        root = archive_fold(&env, &root, &a);
        root = archive_fold(&env, &root, &b);

        // Swapping a record, dropping one, or reordering all break verification.
        assert!(!archive_verify(
            &env,
            &vec![&env, a.clone(), tampered],
            &root
        ));
        assert!(!archive_verify(&env, &vec![&env, a.clone()], &root));
        assert!(!archive_verify(
            &env,
            &vec![&env, b.clone(), a.clone()],
            &root
        ));
    }

    #[test]
    fn archive_membership_supports_restore() {
        let env = Env::default();
        let a = BytesN::from_array(&env, &[1u8; 32]);
        let b = BytesN::from_array(&env, &[2u8; 32]);

        let mut root0 = archive_genesis(&env);
        root0 = archive_fold(&env, &root0, &a);
        let root_after_a = root0.clone();
        let root_after_b = archive_fold(&env, &root0, &b);

        let records = vec![&env, a.clone(), b.clone()];
        // `a` sits at index 0 with the checkpoint captured right after it.
        assert!(archive_contains_at(&env, &records, 0, &a, &root_after_a));
        assert!(archive_contains_at(&env, &records, 1, &b, &root_after_b));
        // Wrong record or wrong checkpoint is rejected.
        assert!(!archive_contains_at(&env, &records, 0, &b, &root_after_a));
        assert!(!archive_contains_at(&env, &records, 1, &b, &root_after_a));
    }
}
