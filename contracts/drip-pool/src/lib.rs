#![no_std]

//! Drip pool contract — hardened with multi-sig admin controls (#140),
//! reentrancy lock guards and lockup enforcement (#139).
//!
//! #263 Reentrancy / cross-contract audit
//! - State changes in DripPool always happen before any future token transfer.
//! - `withdraw` acquires the reentrancy lock before mutating state or removing participant.
//! - No external contract calls exist in the hot path; interactions are placeholders only.
//!
//! #264 Time-locked withdrawals + yield multipliers
//! - `deposit` retains flexible behavior by default.
//! - `deposit_with_duration` allows specifying lockup days; multiplier applied on withdraw.
//! - `withdraw` computes yield-adjusted amount using per-participant lockup_multiplier.
//! - Early withdrawals revert with `LockupActive`.
//!
//! #265 Upgrade path
//! - New proxy contract in `proxy.rs` stores logic contract + admin.
//! - `upgrade` is admin-only; direct caller path enforces auth for transparent proxy.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, vec, Address, BytesN, Env, Vec,
    xdr::ToXdr,
};

// ── Lockup duration (ledgers, ~7 days at 5 s/ledger) ──────────────────────
const LOCKUP_LEDGERS: u32 = 120_960;
// ── Multi-sig threshold: 2-of-N ───────────────────────────────────────────
const SIG_THRESHOLD: u32 = 2;

// ── Storage keys ──────────────────────────────────────────────────────────
// #257: Removed DataKey::Locked and DataKey::ProposalNonce — both fields
// are now inlined into Pool, eliminating two instance-storage round-trips.
#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    Admins, // Vec<Address> — approved signers
    Pool,
    Participant(Address),
    Proposal(u32), // pending admin proposal
}

// ── Errors ─────────────────────────────────────────────────────────────────
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    AlreadyJoined = 3,
    NotJoined = 4,
    InvalidAmount = 5,
    Locked = 6,          // reentrancy
    LockupActive = 7,    // withdrawal before lockup ends
    Unauthorized = 8,    // not an approved signer
    ThresholdNotMet = 9, // not enough signatures
    AlreadySigned = 10,  // signer already approved this proposal
    ProposalNotFound = 11,
    ProposalAlreadyExecuted = 12,
    ProposalCancelled = 13,
    ProposalExpired = 14,
    StaleEpoch = 15,
    InvalidThreshold = 16,
    BootstrapComplete = 17,
}

// ── Proposal Status ────────────────────────────────────────────────────────
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
#[contracttype]
pub enum ProposalStatus {
    Pending = 0,
    Executed = 1,
    Cancelled = 2,
    Expired = 3,
}

// ── Structs ────────────────────────────────────────────────────────────────
// #257: Consolidated `locked` (reentrancy guard) and `proposal_nonce` into
// Pool so both values are read/written in a single instance-storage access.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct Pool {
    pub admin: Address,
    pub total_drips: u64,
    pub total_deposited: i128,
    pub created_at: u64,
    pub locked: bool,        // reentrancy guard (was DataKey::Locked)
    pub proposal_nonce: u32, // monotonic counter (was DataKey::ProposalNonce)
    pub signer_epoch: u32,
    pub signer_set_hash: BytesN<32>,
    pub threshold: u32,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct Participant {
    pub joined_at: u64,
    pub deposited: i128,
    pub claimable: i128,
    pub locked_until: u32,      // ledger sequence
    pub lockup_multiplier: u32, // yield boost in basis points (100 = 1x)
}

/// A pending admin action that requires multi-sig approval.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct Proposal {
    pub id: u32,
    pub action: ProposalAction,
    pub approvals: Vec<Address>,
    pub epoch: u32,
    pub signer_set_hash: BytesN<32>,
    pub expires_at: u64,
    pub proposer: Address,
    pub status: ProposalStatus,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub enum ProposalAction {
    ReleaseEscrow(Address, i128), // recipient, amount
    AddAdmin(Address),
    RemoveAdmin(Address),
    ChangeThreshold(u32),
}

// ── Contract ───────────────────────────────────────────────────────────────
#[contract]
pub struct DripPool;

#[contractimpl]
impl DripPool {
    // ── Reentrancy helpers ─────────────────────────────────────────────────
    fn acquire_lock(pool: &mut Pool) -> Result<(), Error> {
        if pool.locked {
            return Err(Error::Locked);
        }
        pool.locked = true;
        Ok(())
    }

    fn release_lock(pool: &mut Pool) {
        pool.locked = false;
    }

    // ── Multi-sig helpers ──────────────────────────────────────────────────
    fn require_signer(env: &Env, signer: &Address) -> Result<(), Error> {
        let admins: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Admins)
            .unwrap_or(vec![env]);
        if !admins.contains(signer) {
            return Err(Error::Unauthorized);
        }
        Ok(())
    }

    fn validate_quorum(admins_count: u32, threshold: u32) -> Result<(), Error> {
        if threshold == 0 || threshold > admins_count {
            return Err(Error::InvalidThreshold);
        }
        Ok(())
    }

    fn update_signer_set(env: &Env, pool: &mut Pool, new_admins: Vec<Address>) -> Result<(), Error> {
        Self::validate_quorum(new_admins.len() as u32, pool.threshold)?;
        pool.signer_epoch += 1;
        pool.signer_set_hash = env.crypto().sha256(&new_admins.clone().to_xdr(env)).into();
        env.storage().instance().set(&DataKey::Admins, &new_admins);
        env.storage().instance().set(&DataKey::Pool, pool);
        env.events().publish(
            (symbol_short!("epoch_chg"), pool.signer_epoch),
            pool.signer_set_hash.clone(),
        );
        Ok(())
    }

    fn check_proposal_status(
        env: &Env,
        proposal: &mut Proposal,
        current_epoch: u32,
    ) -> Result<(), Error> {
        match proposal.status {
            ProposalStatus::Executed => return Err(Error::ProposalAlreadyExecuted),
            ProposalStatus::Cancelled => return Err(Error::ProposalCancelled),
            ProposalStatus::Expired => return Err(Error::ProposalExpired),
            ProposalStatus::Pending => {}
        }

        if proposal.epoch != current_epoch {
            return Err(Error::StaleEpoch);
        }

        if env.ledger().timestamp() >= proposal.expires_at {
            proposal.status = ProposalStatus::Expired;
            return Err(Error::ProposalExpired);
        }

        Ok(())
    }

    // ── Initialise ─────────────────────────────────────────────────────────
    pub fn create(env: Env, admin: Address) -> Result<(), Error> {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Pool) {
            return Err(Error::AlreadyInitialized);
        }
        let admins: Vec<Address> = vec![&env, admin.clone()];
        let signer_set_hash = env.crypto().sha256(&admins.clone().to_xdr(&env)).into();
        let pool = Pool {
            admin: admin.clone(),
            total_drips: 0,
            total_deposited: 0,
            created_at: env.ledger().timestamp(),
            locked: false,
            proposal_nonce: 0,
            signer_epoch: 1,
            signer_set_hash,
            threshold: SIG_THRESHOLD,
        };
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Admins, &admins);
        env.storage().instance().set(&DataKey::Pool, &pool);
        env.events()
            .publish((symbol_short!("pool"), symbol_short!("created")), admin);
        Ok(())
    }

    pub fn add_admin(env: Env, caller: Address, new_admin: Address) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        let mut pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        let mut admins: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Admins)
            .unwrap_or(vec![&env]);

        if admins.len() >= pool.threshold {
            return Err(Error::BootstrapComplete);
        }

        if !admins.contains(&new_admin) {
            admins.push_back(new_admin);
            Self::update_signer_set(&env, &mut pool, admins)?;
        }
        Ok(())
    }

    pub fn remove_admin(env: Env, caller: Address, target: Address) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;

        let mut pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;

        let admins: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Admins)
            .unwrap_or(vec![&env]);

        if admins.len() <= 1 {
            return Err(Error::Unauthorized);
        }

        if admins.len() >= pool.threshold {
            return Err(Error::BootstrapComplete);
        }

        let mut updated: Vec<Address> = Vec::new(&env);
        for a in admins.iter() {
            if a != target {
                updated.push_back(a);
            }
        }

        Self::update_signer_set(&env, &mut pool, updated)?;
        Ok(())
    }

    // ── Multi-sig: propose an admin action ─────────────────────────────────
    pub fn propose(env: Env, signer: Address, action: ProposalAction) -> Result<u32, Error> {
        signer.require_auth();
        Self::require_signer(&env, &signer)?;

        let mut pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        let nonce = pool.proposal_nonce;
        pool.proposal_nonce += 1;
        env.storage().instance().set(&DataKey::Pool, &pool);

        let expires_at = env.ledger().timestamp() + 7 * 24 * 60 * 60; // 7 days default expiry

        let threshold_met = pool.threshold <= 1;

        let proposal = Proposal {
            id: nonce,
            action: action.clone(),
            approvals: vec![&env, signer.clone()],
            epoch: pool.signer_epoch,
            signer_set_hash: pool.signer_set_hash.clone(),
            expires_at,
            proposer: signer.clone(),
            status: if threshold_met { ProposalStatus::Executed } else { ProposalStatus::Pending },
        };

        env.storage()
            .instance()
            .set(&DataKey::Proposal(nonce), &proposal);

        if threshold_met {
            Self::execute_proposal(&env, &proposal)?;
            env.events().publish(
                (symbol_short!("prop_exe"), nonce),
                pool.signer_epoch,
            );
        }

        env.events().publish(
            (symbol_short!("prop_new"), nonce, signer),
            pool.signer_epoch,
        );

        Ok(nonce)
    }

    /// Approve an existing proposal. Executes automatically when threshold met.
    pub fn approve(env: Env, signer: Address, proposal_id: u32) -> Result<bool, Error> {
        signer.require_auth();
        Self::require_signer(&env, &signer)?;

        let pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;

        let mut proposal: Proposal = env
            .storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(Error::ProposalNotFound)?;

        Self::check_proposal_status(&env, &mut proposal, pool.signer_epoch)?;

        if proposal.approvals.contains(&signer) {
            return Err(Error::AlreadySigned);
        }
        proposal.approvals.push_back(signer.clone());

        env.events().publish(
            (symbol_short!("prop_app"), proposal_id, signer),
            proposal.approvals.len() as u32,
        );

        let threshold_met = proposal.approvals.len() >= pool.threshold;
        if threshold_met {
            proposal.status = ProposalStatus::Executed;
            Self::execute_proposal(&env, &proposal)?;
            env.events().publish(
                (symbol_short!("prop_exe"), proposal_id),
                pool.signer_epoch,
            );
        }

        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        Ok(threshold_met)
    }

    /// Cancel a proposal. Only callable by its proposer.
    pub fn cancel(env: Env, signer: Address, proposal_id: u32) -> Result<(), Error> {
        signer.require_auth();
        Self::require_signer(&env, &signer)?;

        let pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;

        let mut proposal: Proposal = env
            .storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(Error::ProposalNotFound)?;

        Self::check_proposal_status(&env, &mut proposal, pool.signer_epoch)?;

        if proposal.proposer != signer {
            return Err(Error::Unauthorized);
        }

        proposal.status = ProposalStatus::Cancelled;
        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        env.events().publish(
            (symbol_short!("prop_can"), proposal_id),
            signer,
        );

        Ok(())
    }

    fn execute_proposal(env: &Env, proposal: &Proposal) -> Result<(), Error> {
        let mut pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;

        match proposal.action.clone() {
            ProposalAction::AddAdmin(addr) => {
                let mut admins: Vec<Address> = env
                    .storage()
                    .instance()
                    .get(&DataKey::Admins)
                    .unwrap_or(vec![env]);
                if !admins.contains(&addr) {
                    admins.push_back(addr);
                    Self::update_signer_set(env, &mut pool, admins)?;
                }
            }
            ProposalAction::RemoveAdmin(addr) => {
                let admins: Vec<Address> = env
                    .storage()
                    .instance()
                    .get(&DataKey::Admins)
                    .unwrap_or(vec![env]);
                let mut new_admins: Vec<Address> = Vec::new(env);
                for a in admins.iter() {
                    if a != addr {
                        new_admins.push_back(a);
                    }
                }
                Self::update_signer_set(env, &mut pool, new_admins)?;
            }
            ProposalAction::ChangeThreshold(new_threshold) => {
                let admins: Vec<Address> = env
                    .storage()
                    .instance()
                    .get(&DataKey::Admins)
                    .unwrap_or(vec![env]);
                Self::validate_quorum(admins.len() as u32, new_threshold)?;
                pool.threshold = new_threshold;
                env.storage().instance().set(&DataKey::Pool, &pool);

                env.events().publish(
                    (symbol_short!("thresh_ch"), pool.threshold),
                    pool.signer_epoch,
                );
            }
            ProposalAction::ReleaseEscrow(_recipient, _amount) => {
                pool.total_deposited = pool.total_deposited.saturating_sub(_amount);
                env.storage().instance().set(&DataKey::Pool, &pool);
            }
        }
        Ok(())
    }

    // ── Join ───────────────────────────────────────────────────────────────
    pub fn join(env: Env, who: Address) -> Result<(), Error> {
        who.require_auth();
        let key = DataKey::Participant(who.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyJoined);
        }
        env.storage().persistent().set(
            &key,
            &Participant {
                joined_at: env.ledger().timestamp(),
                deposited: 0,
                claimable: 0,
                locked_until: env.ledger().sequence() + LOCKUP_LEDGERS,
                lockup_multiplier: 100,
            },
        );
        env.events()
            .publish((symbol_short!("pool"), symbol_short!("joined")), who);
        Ok(())
    }

    // ── Deposit / drip ─────────────────────────────────────────────────────
    pub fn drip(env: Env, who: Address, amount: i128) -> Result<(), Error> {
        Self::deposit(env, who, amount)
    }

    pub fn deposit(env: Env, who: Address, amount: i128) -> Result<(), Error> {
        who.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let key = DataKey::Participant(who.clone());
        let mut p: Participant = env.storage().persistent().get(&key).unwrap_or(Participant {
            joined_at: env.ledger().timestamp(),
            deposited: 0,
            claimable: 0,
            locked_until: env.ledger().sequence() + LOCKUP_LEDGERS,
            lockup_multiplier: 100,
        });

        p.deposited += amount;
        p.claimable += amount;
        env.storage().persistent().set(&key, &p);

        let mut pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        pool.total_drips += 1;
        pool.total_deposited += amount;
        env.storage().instance().set(&DataKey::Pool, &pool);

        // #255: Deposit event
        env.events().publish(
            (symbol_short!("pool"), symbol_short!("deposit")),
            (who, amount, pool.total_deposited),
        );
        Ok(())
    }

    /// Deposit `amount` with a specific lockup duration (in days).
    pub fn deposit_with_duration(
        env: Env,
        who: Address,
        amount: i128,
        lockup_days: u32,
    ) -> Result<(), Error> {
        who.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let key = DataKey::Participant(who.clone());
        let mut p: Participant = env.storage().persistent().get(&key).unwrap_or(Participant {
            joined_at: env.ledger().timestamp(),
            deposited: 0,
            claimable: 0,
            locked_until: 0,
            lockup_multiplier: 100,
        });

        p.deposited += amount;
        p.claimable += amount;
        p.lockup_multiplier = vault::multiplier_for(lockup_days)?;
        let ledgers = vault::lockup_ledgers_for(lockup_days)?;
        let new_locked_until = env.ledger().sequence() + ledgers;
        if new_locked_until > p.locked_until {
            p.locked_until = new_locked_until;
        }
        env.storage().persistent().set(&key, &p);

        let mut pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        pool.total_drips += 1;
        pool.total_deposited += amount;
        env.storage().instance().set(&DataKey::Pool, &pool);

        env.events().publish(
            (symbol_short!("pool"), symbol_short!("deposit")),
            (who, amount, pool.total_deposited),
        );
        Ok(())
    }

    // ── Claim ──────────────────────────────────────────────────────────────
    pub fn claim(env: Env, who: Address) -> Result<i128, Error> {
        Self::claim_reward(env, who)
    }

    pub fn claim_reward(env: Env, who: Address) -> Result<i128, Error> {
        who.require_auth();

        let key = DataKey::Participant(who.clone());
        let mut p: Participant = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotJoined)?;

        let amount = p.claimable;
        p.claimable = 0;
        env.storage().persistent().set(&key, &p);

        env.events().publish(
            (symbol_short!("pool"), symbol_short!("claimed")),
            (who, amount),
        );
        Ok(amount)
    }

    // ── Withdraw ───────────────────────────────────────────────────────────
    pub fn withdraw(env: Env, who: Address) -> Result<i128, Error> {
        who.require_auth();

        let key = DataKey::Participant(who.clone());
        let p: Participant = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotJoined)?;

        if env.ledger().sequence() < p.locked_until {
            return Err(Error::LockupActive);
        }

        // Reentrancy lock via Pool field (#139 / #257)
        let mut pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        Self::acquire_lock(&mut pool)?;
        env.storage().instance().set(&DataKey::Pool, &pool);

        let amount = (p.deposited as u128)
            .saturating_mul(p.lockup_multiplier as u128)
            .saturating_div(100) as i128;
        env.storage().persistent().remove(&key);

        // token_client.transfer(&env.current_contract_address(), &who, &amount);

        let mut pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        Self::release_lock(&mut pool);
        env.storage().instance().set(&DataKey::Pool, &pool);

        // #255: Withdraw event
        env.events().publish(
            (symbol_short!("pool"), symbol_short!("withdrawn")),
            (who, amount),
        );
        Ok(amount)
    }

    // ── Draw winner ────────────────────────────────────────────────────────
    /// Select a winner from the pool. In production this would use Soroban's
    /// PRNG or a verifiable random beacon; here we select the admin as a
    /// deterministic placeholder so tests can verify the event is emitted.
    ///
    /// #255: Emits the `payout` event documenting who won and for how much.
    pub fn draw_winner(env: Env, caller: Address, prize: i128) -> Result<Address, Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        if prize <= 0 {
            return Err(Error::InvalidAmount);
        }

        let pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;

        // Deterministic selection: admin wins (replace with PRNG in prod).
        let winner = pool.admin.clone();

        // #255: DrawWinner / payout_selected event
        env.events().publish(
            (symbol_short!("pool"), symbol_short!("payout")),
            (winner.clone(), prize),
        );
        Ok(winner)
    }

    // ── Views ──────────────────────────────────────────────────────────────
    pub fn pool(env: Env) -> Result<Pool, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)
    }

    pub fn savings(env: Env, who: Address) -> Result<Participant, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Participant(who))
            .ok_or(Error::NotJoined)
    }

    pub fn admins(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Admins)
            .unwrap_or(vec![&env])
    }
}

// VaultProxy shares export names with DripPool (e.g. `create`), and a
// Soroban wasm binary can only hold one contract — deploying the proxy
// requires moving it to its own workspace crate. Until then it is compiled
// for native builds and tests only, keeping the drip-pool wasm unchanged.
pub mod vault;

#[cfg(not(target_family = "wasm"))]
pub mod proxy;

#[cfg(test)]
mod test;
