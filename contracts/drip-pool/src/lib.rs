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
    contract, contracterror, contractimpl, contracttype, symbol_short, vec, Address, Bytes, BytesN, Env, Vec,
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
    ParticipantsList,
    Draw,
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
    DrawActive = 12,
    NoDrawActive = 13,
    DrawNotCommitted = 14,
    InvalidCommitment = 15,
    DeadlineNotReached = 16,
    DeadlinePassed = 17,
    DuplicateParticipant = 18,
    InvalidParticipantsList = 19,
    DrawNotFrozen = 20,
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

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct Draw {
    pub round_id: u32,
    pub status: DrawStatus,
    pub commitment: BytesN<32>,
    pub freeze_ledger: u32,
    pub reveal_deadline: u32,
    pub prize_amount: i128,
    pub winner: Option<Address>,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub enum DrawStatus {
    None,
    Committed,
    Finalized,
    Cancelled,
}

/// A pending admin action that requires multi-sig approval.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct Proposal {
    pub action: ProposalAction,
    pub approvals: Vec<Address>,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub enum ProposalAction {
    ReleaseEscrow(Address, i128), // recipient, amount
    AddAdmin(Address),
    RemoveAdmin(Address),
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

    fn check_draw_inactive(env: &Env) -> Result<(), Error> {
        if let Some(draw) = env.storage().instance().get::<_, Draw>(&DataKey::Draw) {
            if draw.status == DrawStatus::Committed && env.ledger().sequence() <= draw.reveal_deadline {
                return Err(Error::DrawActive);
            }
        }
        Ok(())
    }

    fn add_to_participants(env: &Env, who: &Address) {
        let mut participants: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::ParticipantsList)
            .unwrap_or(Vec::new(env));
        if !participants.contains(who) {
            participants.push_back(who.clone());
            env.storage().instance().set(&DataKey::ParticipantsList, &participants);
        }
    }

    fn remove_from_participants(env: &Env, who: &Address) {
        let participants: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::ParticipantsList)
            .unwrap_or(Vec::new(env));
        let mut updated = Vec::new(env);
        for p in participants.iter() {
            if &p != who {
                updated.push_back(p);
            }
        }
        env.storage().instance().set(&DataKey::ParticipantsList, &updated);
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

    // ── Initialise ─────────────────────────────────────────────────────────
    pub fn create(env: Env, admin: Address) -> Result<(), Error> {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Pool) {
            return Err(Error::AlreadyInitialized);
        }
        let pool = Pool {
            admin: admin.clone(),
            total_drips: 0,
            total_deposited: 0,
            created_at: env.ledger().timestamp(),
            locked: false,
            proposal_nonce: 0,
        };
        let admins: Vec<Address> = vec![&env, admin.clone()];
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
        let mut admins: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Admins)
            .unwrap_or(vec![&env]);
        if !admins.contains(&new_admin) {
            admins.push_back(new_admin);
            env.storage().instance().set(&DataKey::Admins, &admins);
        }
        Ok(())
    }

    pub fn remove_admin(env: Env, caller: Address, target: Address) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;

        let admins: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Admins)
            .unwrap_or(vec![&env]);

        if admins.len() <= 1 {
            return Err(Error::Unauthorized);
        }

        let mut updated: Vec<Address> = Vec::new(&env);
        for a in admins.iter() {
            if a != target {
                updated.push_back(a);
            }
        }

        env.storage().instance().set(&DataKey::Admins, &updated);
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

        let proposal = Proposal {
            action,
            approvals: vec![&env, signer],
        };
        env.storage()
            .instance()
            .set(&DataKey::Proposal(nonce), &proposal);
        Ok(nonce)
    }

    /// Approve an existing proposal. Executes automatically when threshold met.
    pub fn approve(env: Env, signer: Address, proposal_id: u32) -> Result<bool, Error> {
        signer.require_auth();
        Self::require_signer(&env, &signer)?;

        let mut proposal: Proposal = env
            .storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(Error::ProposalNotFound)?;

        if proposal.approvals.contains(&signer) {
            return Err(Error::AlreadySigned);
        }
        proposal.approvals.push_back(signer);

        let threshold_met = proposal.approvals.len() >= SIG_THRESHOLD;
        if threshold_met {
            Self::execute_proposal(&env, &proposal)?;
            env.storage()
                .instance()
                .remove(&DataKey::Proposal(proposal_id));
        } else {
            env.storage()
                .instance()
                .set(&DataKey::Proposal(proposal_id), &proposal);
        }
        Ok(threshold_met)
    }

    fn execute_proposal(env: &Env, proposal: &Proposal) -> Result<(), Error> {
        match proposal.action.clone() {
            ProposalAction::AddAdmin(addr) => {
                let mut admins: Vec<Address> = env
                    .storage()
                    .instance()
                    .get(&DataKey::Admins)
                    .unwrap_or(vec![env]);
                if !admins.contains(&addr) {
                    admins.push_back(addr);
                    env.storage().instance().set(&DataKey::Admins, &admins);
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
                env.storage().instance().set(&DataKey::Admins, &new_admins);
            }
            ProposalAction::ReleaseEscrow(_recipient, _amount) => {
                let mut pool: Pool = env
                    .storage()
                    .instance()
                    .get(&DataKey::Pool)
                    .ok_or(Error::NotInitialized)?;
                pool.total_deposited = pool.total_deposited.saturating_sub(_amount);
                env.storage().instance().set(&DataKey::Pool, &pool);
            }
        }
        Ok(())
    }

    // ── Join ───────────────────────────────────────────────────────────────
    pub fn join(env: Env, who: Address) -> Result<(), Error> {
        who.require_auth();
        Self::check_draw_inactive(&env)?;
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
        Self::add_to_participants(&env, &who);
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
        Self::check_draw_inactive(&env)?;
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let key = DataKey::Participant(who.clone());
        let is_new = !env.storage().persistent().has(&key);
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

        if is_new {
            Self::add_to_participants(&env, &who);
        }

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
        Self::check_draw_inactive(&env)?;
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let key = DataKey::Participant(who.clone());
        let is_new = !env.storage().persistent().has(&key);
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

        if is_new {
            Self::add_to_participants(&env, &who);
        }

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
        Self::check_draw_inactive(&env)?;

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
        Self::remove_from_participants(&env, &who);

        // token_client.transfer(&env.current_contract_address(), &who, &amount);

        let mut pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        pool.total_deposited = pool.total_deposited.saturating_sub(p.deposited);
        Self::release_lock(&mut pool);
        env.storage().instance().set(&DataKey::Pool, &pool);

        // #255: Withdraw event
        env.events().publish(
            (symbol_short!("pool"), symbol_short!("withdrawn")),
            (who, amount),
        );
        Ok(amount)
    }

    // ── Draw winner (legacy / PRNG fallback) ────────────────────────────────
    /// Select a winner from the pool using the environment's PRNG.
    /// Emits the `payout` event documenting who won and for how much.
    pub fn draw_winner(env: Env, caller: Address, prize: i128) -> Result<Address, Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        if prize <= 0 {
            return Err(Error::InvalidAmount);
        }

        Self::check_draw_inactive(&env)?;

        let participants: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::ParticipantsList)
            .unwrap_or(Vec::new(&env));

        let mut total_weight: u64 = 0;
        for i in 0..participants.len() {
            let addr = participants.get_unchecked(i);
            if let Some(p) = env
                .storage()
                .persistent()
                .get::<_, Participant>(&DataKey::Participant(addr.clone())) {
                if p.deposited > 0 {
                    total_weight += p.deposited as u64;
                }
            }
        }

        if total_weight == 0 {
            return Err(Error::InvalidAmount);
        }

        let limit = total_weight;
        let cutoff = u64::MAX - (u64::MAX % limit);
        let random_val = loop {
            let x = env.prng().gen::<u64>();
            if x < cutoff {
                break x % limit;
            }
        };

        let mut current_sum = 0u64;
        let mut winner = participants.get_unchecked(0);

        for i in 0..participants.len() {
            let addr = participants.get_unchecked(i);
            if let Some(p) = env
                .storage()
                .persistent()
                .get::<_, Participant>(&DataKey::Participant(addr.clone())) {
                if p.deposited > 0 {
                    current_sum += p.deposited as u64;
                    if current_sum > random_val {
                        winner = addr;
                        break;
                    }
                }
            }
        }

        // Update winner's claimable reward in state
        let mut win_p: Participant = env
            .storage()
            .persistent()
            .get(&DataKey::Participant(winner.clone()))
            .unwrap();
        win_p.claimable = win_p
            .claimable
            .checked_add(prize)
            .ok_or(Error::InvalidAmount)?;
        env.storage()
            .persistent()
            .set(&DataKey::Participant(winner.clone()), &win_p);

        env.events().publish(
            (symbol_short!("pool"), symbol_short!("payout")),
            (winner.clone(), prize),
        );
        Ok(winner)
    }

    // ── Verifiable Randomness Draw Lifecycle ────────────────────────────────

    pub fn commit_draw(
        env: Env,
        caller: Address,
        round_id: u32,
        commitment: BytesN<32>,
        freeze_ledger: u32,
        reveal_deadline: u32,
        prize: i128,
    ) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;

        if prize <= 0 {
            return Err(Error::InvalidAmount);
        }

        // Verify no active draw is currently running
        if let Some(draw) = env.storage().instance().get::<_, Draw>(&DataKey::Draw) {
            if draw.status == DrawStatus::Committed && env.ledger().sequence() <= draw.reveal_deadline {
                return Err(Error::DrawActive);
            }
        }

        let current_ledger = env.ledger().sequence();
        if freeze_ledger < current_ledger {
            return Err(Error::InvalidAmount); // freeze_ledger must be >= current_ledger
        }
        if reveal_deadline <= freeze_ledger {
            return Err(Error::InvalidAmount); // reveal_deadline must be > freeze_ledger
        }

        let draw = Draw {
            round_id,
            status: DrawStatus::Committed,
            commitment: commitment.clone(),
            freeze_ledger,
            reveal_deadline,
            prize_amount: prize,
            winner: None,
        };

        env.storage().instance().set(&DataKey::Draw, &draw);

        env.events().publish(
            (symbol_short!("draw"), symbol_short!("commit")),
            (round_id, commitment, freeze_ledger, reveal_deadline, prize),
        );

        Ok(())
    }

    pub fn finalize_draw(
        env: Env,
        revealed_secret: BytesN<32>,
        participants: Vec<Address>,
    ) -> Result<Address, Error> {
        let mut draw = env
            .storage()
            .instance()
            .get::<_, Draw>(&DataKey::Draw)
            .ok_or(Error::NoDrawActive)?;

        if draw.status != DrawStatus::Committed {
            return Err(Error::DrawNotCommitted);
        }

        let current_ledger = env.ledger().sequence();
        if current_ledger <= draw.freeze_ledger {
            return Err(Error::DrawNotFrozen);
        }
        if current_ledger > draw.reveal_deadline {
            return Err(Error::DeadlinePassed);
        }

        // Verify secret matches commitment
        let secret_hash: BytesN<32> = env.crypto().sha256(revealed_secret.as_ref()).into();
        if secret_hash != draw.commitment {
            return Err(Error::InvalidCommitment);
        }

        // Verify participants list and compute weights
        let mut total_weight: u64 = 0;
        let mut checked_participants = Vec::new(&env);

        for i in 0..participants.len() {
            let addr = participants.get_unchecked(i);
            if checked_participants.contains(&addr) {
                return Err(Error::DuplicateParticipant);
            }
            checked_participants.push_back(addr.clone());

            let p: Participant = env
                .storage()
                .persistent()
                .get(&DataKey::Participant(addr.clone()))
                .ok_or(Error::NotJoined)?;

            if p.deposited > 0 {
                total_weight = total_weight
                    .checked_add(p.deposited as u64)
                    .ok_or(Error::InvalidAmount)?;
            }
        }

        let pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;

        // Verify the participants list is complete: the sum of the deposits of all passed
        // participants must equal the pool's total_deposited.
        if total_weight as i128 != pool.total_deposited {
            return Err(Error::InvalidParticipantsList);
        }

        if total_weight == 0 {
            return Err(Error::InvalidAmount); // Cannot draw if no eligible deposits
        }

        // Generate the seed with Domain Separation:
        // Hash of (network_id, contract_address, round_id, freeze_ledger, revealed_secret)
        use soroban_sdk::xdr::ToXdr;
        let mut seed_bytes = Bytes::new(&env);
        seed_bytes.append(env.ledger().network_id().as_ref());
        seed_bytes.append(&env.current_contract_address().to_xdr(&env));
        seed_bytes.append(&draw.round_id.to_xdr(&env));
        seed_bytes.append(&draw.freeze_ledger.to_xdr(&env));
        seed_bytes.append(revealed_secret.as_ref());
        let seed: BytesN<32> = env.crypto().sha256(&seed_bytes).into();

        // Select winner using rejection sampling to avoid modulo bias
        let mut counter: u32 = 0;
        let limit = total_weight;
        let cutoff = u64::MAX - (u64::MAX % limit);
        let random_val = loop {
            let mut input = Bytes::new(&env);
            input.append(seed.as_ref());
            input.append(&counter.to_xdr(&env));
            counter += 1;
            let hash: BytesN<32> = env.crypto().sha256(&input).into();

            let mut bytes = [0u8; 8];
            for i in 0..8 {
                bytes[i] = hash.get_unchecked(i as u32);
            }
            let x = u64::from_be_bytes(bytes);

            if x < cutoff {
                break x % limit;
            }
        };

        // Find winner
        let mut current_sum = 0u64;
        let mut winner = participants.get_unchecked(0);
        let mut found = false;

        for i in 0..participants.len() {
            let addr = participants.get_unchecked(i);
            let p: Participant = env
                .storage()
                .persistent()
                .get(&DataKey::Participant(addr.clone()))
                .unwrap();

            if p.deposited > 0 {
                current_sum += p.deposited as u64;
                if current_sum > random_val {
                    winner = addr;
                    found = true;
                    break;
                }
            }
        }

        if !found {
            winner = participants.get_unchecked(0);
        }

        // Update winner's claimable reward in state
        let mut win_p: Participant = env
            .storage()
            .persistent()
            .get(&DataKey::Participant(winner.clone()))
            .unwrap();
        win_p.claimable = win_p
            .claimable
            .checked_add(draw.prize_amount)
            .ok_or(Error::InvalidAmount)?;
        env.storage()
            .persistent()
            .set(&DataKey::Participant(winner.clone()), &win_p);

        // Update draw state
        draw.status = DrawStatus::Finalized;
        draw.winner = Some(winner.clone());
        env.storage().instance().set(&DataKey::Draw, &draw);

        // Publish proof material and payout event
        env.events().publish(
            (symbol_short!("draw"), symbol_short!("finalized")),
            (
                draw.round_id,
                winner.clone(),
                draw.prize_amount,
                seed.clone(),
                revealed_secret.clone(),
            ),
        );

        env.events().publish(
            (symbol_short!("pool"), symbol_short!("payout")),
            (winner.clone(), draw.prize_amount),
        );

        Ok(winner)
    }

    pub fn cancel_draw(env: Env, caller: Address) -> Result<(), Error> {
        caller.require_auth();

        let mut draw = env
            .storage()
            .instance()
            .get::<_, Draw>(&DataKey::Draw)
            .ok_or(Error::NoDrawActive)?;

        if draw.status != DrawStatus::Committed {
            return Err(Error::DrawNotCommitted);
        }

        let current_ledger = env.ledger().sequence();
        let is_admin = Self::require_signer(&env, &caller).is_ok();

        if !is_admin && current_ledger <= draw.reveal_deadline {
            return Err(Error::DeadlineNotReached);
        }

        draw.status = DrawStatus::Cancelled;
        env.storage().instance().set(&DataKey::Draw, &draw);

        env.events().publish(
            (symbol_short!("draw"), symbol_short!("cancelled")),
            draw.round_id,
        );

        Ok(())
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
