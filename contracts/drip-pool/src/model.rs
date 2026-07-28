//! #33 Implementation-independent reference model for pool solvency.
//!
//! A pure, `std`-side model of the drip pool's observable state and the outcome
//! of every solvency-critical entrypoint. It knows nothing about Soroban — no
//! `Env`, no storage, no auth — so it is an independent oracle: the property
//! tests drive the same command against both this model and the real contract
//! and assert they agree, then check invariants against the contract's state.
//!
//! Scope. The model covers the balance/solvency surface — create, join,
//! deposit, deposit_with_duration, claim, withdraw — which is what "pool
//! solvency" (#33) turns on. The multisig-governance entrypoints (propose /
//! approve / cancel / add_admin / remove_admin, with their threshold, epoch,
//! and bootstrap rules) and the commit/reveal raffle (commit_draw /
//! finalize_draw / cancel_draw) are separate state machines with their own
//! dedicated tests in `test.rs`. No draw is ever started, so the
//! `check_draw_inactive` guard on the modelled entrypoints is always satisfied.
//!
//! The model mirrors the contract's accounting exactly, including:
//!   - `deposit` on a never-joined actor auto-creates a participant;
//!   - `withdraw` removes the participant and subtracts its principal from
//!     `total_deposited`, so `total_deposited` always equals the sum of current
//!     participants' principal;
//!   - `total_drips` is a lifetime deposit counter that `withdraw` leaves alone.

#[cfg(test)]
extern crate std;

#[cfg(test)]
use std::collections::BTreeMap;

/// Mirrors `Error` in `lib.rs`, restricted to the variants the modelled
/// entrypoints can produce.
#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelError {
    AlreadyInitialized,
    NotInitialized,
    AlreadyJoined,
    NotJoined,
    InvalidAmount,
    LockupActive,
    MathOverflow,
}

#[cfg(test)]
pub const DEFAULT_MULTIPLIER: u32 = 100;
#[cfg(test)]
pub const LOCKUP_LEDGERS: u32 = 120_960;

#[cfg(test)]
fn multiplier_for(days: u32) -> u32 {
    match days {
        0 => 100,
        1..=7 => 110,
        8..=14 => 125,
        _ => 150,
    }
}

#[cfg(test)]
fn lockup_ledgers_for(days: u32) -> u32 {
    match days {
        0 => 0,
        1..=7 => 7 * 17_280,
        8..=14 => 14 * 17_280,
        _ => 90 * 17_280,
    }
}

#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelParticipant {
    pub deposited: i128,
    pub claimable: i128,
    pub locked_until: u32,
    pub lockup_multiplier: u32,
}

/// Actors are referenced by a small index so commands are cheap to generate and
/// shrink. Index 0 is the creator/admin.
#[cfg(test)]
pub type Actor = u8;

#[cfg(test)]
#[derive(Clone, Debug, Default)]
pub struct Model {
    pub initialized: bool,
    pub participants: BTreeMap<Actor, ModelParticipant>,
    pub total_deposited: i128,
    pub total_drips: u64,
    pub ledger_seq: u32,
}

#[cfg(test)]
impl Model {
    fn checked_add(a: i128, b: i128) -> Result<i128, ModelError> {
        a.checked_add(b).ok_or(ModelError::MathOverflow)
    }

    pub fn create(&mut self) -> Result<(), ModelError> {
        if self.initialized {
            return Err(ModelError::AlreadyInitialized);
        }
        self.initialized = true;
        Ok(())
    }

    pub fn join(&mut self, who: Actor) -> Result<(), ModelError> {
        if self.participants.contains_key(&who) {
            return Err(ModelError::AlreadyJoined);
        }
        self.participants.insert(
            who,
            ModelParticipant {
                deposited: 0,
                claimable: 0,
                locked_until: self.ledger_seq + LOCKUP_LEDGERS,
                lockup_multiplier: DEFAULT_MULTIPLIER,
            },
        );
        Ok(())
    }

    pub fn deposit(&mut self, who: Actor, amount: i128) -> Result<(), ModelError> {
        if amount <= 0 {
            return Err(ModelError::InvalidAmount);
        }
        if !self.initialized {
            // The contract upserts the participant, then reads Pool and errors
            // NotInitialized, rolling the whole call back. The model likewise
            // leaves nothing behind.
            return Err(ModelError::NotInitialized);
        }
        // Compute every checked value before committing, so an overflow leaves
        // the model untouched exactly as the contract rolls the call back.
        let base = self
            .participants
            .get(&who)
            .cloned()
            .unwrap_or(ModelParticipant {
                deposited: 0,
                claimable: 0,
                locked_until: self.ledger_seq + LOCKUP_LEDGERS,
                lockup_multiplier: DEFAULT_MULTIPLIER,
            });
        let new_deposited = Self::checked_add(base.deposited, amount)?;
        let new_claimable = Self::checked_add(base.claimable, amount)?;
        let new_total = Self::checked_add(self.total_deposited, amount)?;

        self.participants.insert(
            who,
            ModelParticipant {
                deposited: new_deposited,
                claimable: new_claimable,
                ..base
            },
        );
        self.total_deposited = new_total;
        self.total_drips += 1;
        Ok(())
    }

    pub fn deposit_with_duration(
        &mut self,
        who: Actor,
        amount: i128,
        days: u32,
    ) -> Result<(), ModelError> {
        if amount <= 0 {
            return Err(ModelError::InvalidAmount);
        }
        if !self.initialized {
            return Err(ModelError::NotInitialized);
        }
        let seq = self.ledger_seq;
        let base = self
            .participants
            .get(&who)
            .cloned()
            .unwrap_or(ModelParticipant {
                deposited: 0,
                claimable: 0,
                locked_until: 0,
                lockup_multiplier: DEFAULT_MULTIPLIER,
            });
        let new_deposited = Self::checked_add(base.deposited, amount)?;
        let new_claimable = Self::checked_add(base.claimable, amount)?;
        let new_total = Self::checked_add(self.total_deposited, amount)?;

        let new_locked_until = (seq + lockup_ledgers_for(days)).max(base.locked_until);
        self.participants.insert(
            who,
            ModelParticipant {
                deposited: new_deposited,
                claimable: new_claimable,
                lockup_multiplier: multiplier_for(days),
                locked_until: new_locked_until,
            },
        );
        self.total_deposited = new_total;
        self.total_drips += 1;
        Ok(())
    }

    pub fn claim(&mut self, who: Actor) -> Result<i128, ModelError> {
        let entry = self
            .participants
            .get_mut(&who)
            .ok_or(ModelError::NotJoined)?;
        let amount = entry.claimable;
        entry.claimable = 0;
        Ok(amount)
    }

    pub fn withdraw(&mut self, who: Actor) -> Result<i128, ModelError> {
        let entry = self.participants.get(&who).ok_or(ModelError::NotJoined)?;
        if self.ledger_seq < entry.locked_until {
            return Err(ModelError::LockupActive);
        }
        // The contract reads Pool for its reentrancy lock, so a participant that
        // joined a never-created pool cannot withdraw. This check sits after the
        // lockup check to match the contract's exact error precedence:
        // NotJoined, then LockupActive, then NotInitialized.
        if !self.initialized {
            return Err(ModelError::NotInitialized);
        }
        let deposited = entry.deposited;
        // saturating, matching the contract.
        let amount = (deposited as u128)
            .saturating_mul(entry.lockup_multiplier as u128)
            .saturating_div(100) as i128;
        self.participants.remove(&who);
        // withdraw subtracts the withdrawn principal from the pool total.
        self.total_deposited = self.total_deposited.saturating_sub(deposited);
        Ok(amount)
    }

    pub fn advance_ledger(&mut self, by: u32) {
        self.ledger_seq = self.ledger_seq.saturating_add(by);
    }

    // ── Invariants ──────────────────────────────────────────────────────────

    /// Solvency conservation: the pool total equals the sum of every current
    /// participant's principal. Deposits add to both sides, withdrawals remove
    /// from both, so the two can never drift.
    pub fn check_conservation(&self) {
        let sum: i128 = self.participants.values().map(|p| p.deposited).sum();
        assert_eq!(
            self.total_deposited, sum,
            "total_deposited must equal the sum of current participants' principal",
        );
        assert!(self.total_deposited >= 0, "total_deposited went negative");
    }

    /// No balance is ever negative, rewards are bounded by principal, and the
    /// yield multiplier stays within its tier bounds.
    pub fn check_balances(&self) {
        for (actor, p) in &self.participants {
            assert!(p.deposited >= 0, "actor {actor} deposited < 0");
            assert!(p.claimable >= 0, "actor {actor} claimable < 0");
            assert!(
                p.claimable <= p.deposited,
                "actor {actor} claimable {} exceeds deposited {}",
                p.claimable,
                p.deposited,
            );
            assert!(
                (100..=150).contains(&p.lockup_multiplier),
                "actor {actor} multiplier {} out of tier bounds",
                p.lockup_multiplier,
            );
        }
    }
}
