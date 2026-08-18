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
//! #265/#32 Upgrade path
//! - Proxy contract in `proxy.rs` stores logic contract + governance metadata.
//! - Upgrades require signer quorum, an observation timelock, approved hashes,
//!   migration simulation, invariant checks, and rollback write-preservation.
//!
//! #72 Share-based NAV vault (`shares.rs` + the `vault_*` methods below) — additive, on its own storage keys.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, vec, xdr::ToXdr, Address,
    Bytes, BytesN, Env, Vec,
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

#[derive(Clone)]
#[contracttype]
pub enum VaultKey {
    VaultShares,
    ShareBalance(Address),
    WithdrawalNonce,
    WithdrawalRequest(u32),
    WithdrawalOwner(u32),
    WithdrawalDestination(u32),
    WithdrawalQueue,
    WithdrawalHead,
    FeeRecipient,
    DustBeneficiary,
    ManagementFeeBps,
    PerformanceFeeBps,
    VaultPaused,
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
    InvalidThreshold = 21,
    BootstrapComplete = 22,
    ProposalAlreadyExecuted = 23,
    ProposalCancelled = 24,
    ProposalExpired = 25,
    StaleEpoch = 26,
    StaleSnapshot = 27,
    InsufficientShares = 28,
    MathOverflow = 29,
    RoundsToZero = 30,
    InsufficientBalance = 31,
    WithdrawalNotFound = 32,
    WithdrawalAlreadySettled = 33,
    ExceedsOwed = 34,
    NothingToSweep = 35,
    QueueBlocked = 36,
    WithdrawalNotCancellable = 37,
    Paused = 38,
    InvalidHaircut = 39,
    /// #108: the legacy drip/deposit/withdraw accounting path and the
    /// share-based vault are two independent, non-transfer-verified balance
    /// systems on the same pool. Once either has been used, switching to the
    /// other is rejected so their totals can never silently diverge or be
    /// double-counted against the same (unverified) custody.
    MixedAccountingModeNotAllowed = 40,
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

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct WithdrawalQueueStatus {
    pub request_id: u32,
    pub owner: Address,
    pub destination: Address,
    pub shares_burned: i128,
    pub assets_owed: i128,
    pub assets_paid: i128,
    pub assets_claimed: i128,
    pub claimable_assets: i128,
    pub remaining_assets: i128,
    pub min_output: i128,
    pub requested_ledger: u32,
    pub expires_ledger: u32,
    pub emergency_haircut_bps: u32,
    pub state: shares::WithdrawalState,
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
    // ── Vault economic mutations — require quorum (#107) ──────────────────
    VaultReportGain(i128),                       // amount
    VaultReportLoss(i128),                       // amount
    VaultSetFeeRecipient(Address),               // new recipient
    VaultSetManagementFeeBps(u32),               // bps
    VaultSetPerformanceFeeBps(u32),              // bps
    VaultApplyEmergencyHaircut(u32, u32),        // (request_id, haircut_bps)
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub enum ProposalStatus {
    Pending,
    Executed,
    Cancelled,
    Expired,
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
            if draw.status == DrawStatus::Committed
                && env.ledger().sequence() <= draw.reveal_deadline
            {
                return Err(Error::DrawActive);
            }
        }
        Ok(())
    }

    /// #108: the legacy accounting path (`deposit`/`drip`/`deposit_with_duration`)
    /// and the share-based vault (`vault_deposit`) both track pool balances
    /// without independently verified token custody. Neither can tell
    /// whether the other has already "moved" the same underlying assets, so
    /// once one system has recorded a real balance the other is locked out
    /// for this pool - this is what stops totals from silently diverging or
    /// the same custody being double-counted across both systems.
    fn check_legacy_accounting_allowed(env: &Env) -> Result<(), Error> {
        if let Some(snapshot) = env
            .storage()
            .instance()
            .get::<_, shares::VaultSnapshot>(&VaultKey::VaultShares)
        {
            if snapshot.total_shares > 0 {
                return Err(Error::MixedAccountingModeNotAllowed);
            }
        }
        Ok(())
    }

    fn check_vault_accounting_allowed(env: &Env) -> Result<(), Error> {
        if let Some(pool) = env.storage().instance().get::<_, Pool>(&DataKey::Pool) {
            if pool.total_deposited > 0 {
                return Err(Error::MixedAccountingModeNotAllowed);
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
            env.storage()
                .instance()
                .set(&DataKey::ParticipantsList, &participants);
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
        env.storage()
            .instance()
            .set(&DataKey::ParticipantsList, &updated);
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

    fn update_signer_set(
        env: &Env,
        pool: &mut Pool,
        new_admins: Vec<Address>,
    ) -> Result<(), Error> {
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
            status: if threshold_met {
                ProposalStatus::Executed
            } else {
                ProposalStatus::Pending
            },
        };

        env.storage()
            .instance()
            .set(&DataKey::Proposal(nonce), &proposal);

        if threshold_met {
            Self::execute_proposal(&env, &proposal)?;
            env.events()
                .publish((symbol_short!("prop_exe"), nonce), pool.signer_epoch);
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
            env.events()
                .publish((symbol_short!("prop_exe"), proposal_id), pool.signer_epoch);
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

        env.events()
            .publish((symbol_short!("prop_can"), proposal_id), signer);

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
            // ── Vault economic mutations — quorum-gated (#107) ────────────
            ProposalAction::VaultReportGain(amount) => {
                let mut snapshot = Self::load_vault(env)?;
                shares::report_gain(&mut snapshot, amount)?;
                Self::save_vault(env, &snapshot);
                env.events().publish(
                    (symbol_short!("vault"), symbol_short!("gain")),
                    (amount, proposal.epoch),
                );
            }
            ProposalAction::VaultReportLoss(amount) => {
                let mut snapshot = Self::load_vault(env)?;
                shares::report_loss(&mut snapshot, amount)?;
                Self::save_vault(env, &snapshot);
                env.events().publish(
                    (symbol_short!("vault"), symbol_short!("loss")),
                    (amount, proposal.epoch),
                );
            }
            ProposalAction::VaultSetFeeRecipient(recipient) => {
                env.storage()
                    .instance()
                    .set(&VaultKey::FeeRecipient, &recipient);
                env.events().publish(
                    (symbol_short!("vault"), symbol_short!("fee_rcpt")),
                    (recipient, proposal.epoch),
                );
            }
            ProposalAction::VaultSetManagementFeeBps(bps) => {
                env.storage()
                    .instance()
                    .set(&VaultKey::ManagementFeeBps, &bps);
                env.events().publish(
                    (symbol_short!("vault"), symbol_short!("mgmt_bps")),
                    (bps, proposal.epoch),
                );
            }
            ProposalAction::VaultSetPerformanceFeeBps(bps) => {
                env.storage()
                    .instance()
                    .set(&VaultKey::PerformanceFeeBps, &bps);
                env.events().publish(
                    (symbol_short!("vault"), symbol_short!("perf_bps")),
                    (bps, proposal.epoch),
                );
            }
            ProposalAction::VaultApplyEmergencyHaircut(request_id, haircut_bps) => {
                let mut request: shares::WithdrawalRequest = env
                    .storage()
                    .persistent()
                    .get(&VaultKey::WithdrawalRequest(request_id))
                    .ok_or(Error::WithdrawalNotFound)?;
                let mut snapshot = Self::load_vault(env)?;
                let reduction =
                    shares::apply_emergency_haircut(&mut snapshot, &mut request, haircut_bps)?;
                env.storage()
                    .persistent()
                    .set(&VaultKey::WithdrawalRequest(request_id), &request);
                if Self::is_terminal_withdrawal(&request) {
                    Self::refresh_withdrawal_head(env);
                }
                Self::save_vault(env, &snapshot);
                env.events().publish(
                    (symbol_short!("vault"), symbol_short!("q_haircut")),
                    (request_id, haircut_bps, reduction, proposal.epoch),
                );
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
        Self::check_legacy_accounting_allowed(&env)?;
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
        Self::check_legacy_accounting_allowed(&env)?;
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
    /// #108: this legacy withdrawal pays out a *calculated* amount without a
    /// verified custody transfer (the token transfer below is intentionally
    /// left commented - see the caveat where it's referenced). It can only
    /// ever pay out what legacy `deposit`/`drip`/`deposit_with_duration`
    /// recorded, and those are now blocked once the share-based vault has
    /// been used on this pool (`check_legacy_accounting_allowed`), so this
    /// can no longer diverge from or double-count against vault accounting.
    /// It remains a known limitation that this path was never wired to a
    /// real token client; production deployments must not rely on it moving
    /// funds until that custody wiring exists.
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
                .get::<_, Participant>(&DataKey::Participant(addr.clone()))
            {
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
                .get::<_, Participant>(&DataKey::Participant(addr.clone()))
            {
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
            if draw.status == DrawStatus::Committed
                && env.ledger().sequence() <= draw.reveal_deadline
            {
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

    // ── #72: share-based NAV vault — additive, its own storage keys ──────────

    pub fn vault_init(env: Env, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        if env.storage().instance().has(&VaultKey::VaultShares) {
            return Err(Error::AlreadyInitialized);
        }
        let snapshot = shares::VaultSnapshot::new(env.ledger().timestamp())?;
        env.storage()
            .instance()
            .set(&VaultKey::VaultShares, &snapshot);
        env.storage()
            .instance()
            .set(&VaultKey::WithdrawalNonce, &0u32);
        env.storage()
            .instance()
            .set(&VaultKey::WithdrawalQueue, &Vec::<u32>::new(&env));
        env.storage()
            .instance()
            .set(&VaultKey::WithdrawalHead, &0u32);
        env.storage()
            .instance()
            .set(&VaultKey::FeeRecipient, &caller);
        env.storage()
            .instance()
            .set(&VaultKey::DustBeneficiary, &caller);
        env.storage()
            .instance()
            .set(&VaultKey::ManagementFeeBps, &0u32);
        env.storage()
            .instance()
            .set(&VaultKey::PerformanceFeeBps, &0u32);
        env.storage().instance().set(&VaultKey::VaultPaused, &false);
        env.events()
            .publish((symbol_short!("vault"), symbol_short!("init")), caller);
        Ok(())
    }

    fn load_vault(env: &Env) -> Result<shares::VaultSnapshot, Error> {
        env.storage()
            .instance()
            .get(&VaultKey::VaultShares)
            .ok_or(Error::NotInitialized)
    }

    fn save_vault(env: &Env, snapshot: &shares::VaultSnapshot) {
        env.storage()
            .instance()
            .set(&VaultKey::VaultShares, snapshot);
    }

    fn fee_config(env: &Env) -> Result<(u32, u32), Error> {
        let management: u32 = env
            .storage()
            .instance()
            .get(&VaultKey::ManagementFeeBps)
            .ok_or(Error::NotInitialized)?;
        let performance: u32 = env
            .storage()
            .instance()
            .get(&VaultKey::PerformanceFeeBps)
            .ok_or(Error::NotInitialized)?;
        Ok((management, performance))
    }

    /// Runs before any share-supply change so no depositor/withdrawer can dodge an owed fee.
    fn checkpoint_fees(env: &Env, snapshot: &mut shares::VaultSnapshot) -> Result<(), Error> {
        let (management_bps, performance_bps) = Self::fee_config(env)?;

        let management_fee =
            shares::accrue_management_fee(snapshot, env.ledger().timestamp(), management_bps)?;
        if management_fee > 0 {
            env.events().publish(
                (symbol_short!("vault"), symbol_short!("mgmtfee")),
                (management_fee, snapshot.version),
            );
        }

        let performance_fee = shares::accrue_performance_fee(snapshot, performance_bps)?;
        if performance_fee > 0 {
            env.events().publish(
                (symbol_short!("vault"), symbol_short!("perffee")),
                (performance_fee, snapshot.high_water_mark),
            );
        }
        Ok(())
    }

    fn ensure_vault_unpaused(env: &Env) -> Result<(), Error> {
        let paused: bool = env
            .storage()
            .instance()
            .get(&VaultKey::VaultPaused)
            .unwrap_or(false);
        if paused {
            return Err(Error::Paused);
        }
        Ok(())
    }

    fn is_terminal_withdrawal(request: &shares::WithdrawalRequest) -> bool {
        request.state != shares::WithdrawalState::Active
    }

    fn queue_head(env: &Env) -> u32 {
        env.storage()
            .instance()
            .get(&VaultKey::WithdrawalHead)
            .unwrap_or(0)
    }

    fn withdrawal_queue(env: &Env) -> Vec<u32> {
        env.storage()
            .instance()
            .get(&VaultKey::WithdrawalQueue)
            .unwrap_or(Vec::new(env))
    }

    fn save_withdrawal_head(env: &Env, head: u32) {
        env.storage()
            .instance()
            .set(&VaultKey::WithdrawalHead, &head);
    }

    fn first_queued_request(env: &Env) -> Option<u32> {
        let queue = Self::withdrawal_queue(env);
        let mut head = Self::queue_head(env);
        while head < queue.len() {
            let request_id = queue.get_unchecked(head);
            match env
                .storage()
                .persistent()
                .get::<_, shares::WithdrawalRequest>(&VaultKey::WithdrawalRequest(request_id))
            {
                Some(request) if Self::is_terminal_withdrawal(&request) => {
                    head += 1;
                    Self::save_withdrawal_head(env, head);
                }
                Some(_) => return Some(request_id),
                None => {
                    head += 1;
                    Self::save_withdrawal_head(env, head);
                }
            }
        }
        None
    }

    fn refresh_withdrawal_head(env: &Env) {
        let _ = Self::first_queued_request(env);
    }

    fn maybe_expire_request(
        env: &Env,
        snapshot: &mut shares::VaultSnapshot,
        request_id: u32,
        request: &mut shares::WithdrawalRequest,
    ) -> Result<bool, Error> {
        if request.expires_ledger == 0 || env.ledger().sequence() <= request.expires_ledger {
            return Ok(false);
        }
        let restored = shares::expire_withdrawal(snapshot, request)?;
        let owner: Address = env
            .storage()
            .persistent()
            .get(&VaultKey::WithdrawalOwner(request_id))
            .ok_or(Error::WithdrawalNotFound)?;
        let balance_key = VaultKey::ShareBalance(owner.clone());
        let balance: i128 = env.storage().persistent().get(&balance_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&balance_key, &(balance + restored));
        env.events().publish(
            (symbol_short!("vault"), symbol_short!("q_expire")),
            (request_id, owner, restored),
        );
        Ok(true)
    }

    fn withdrawal_status(
        env: &Env,
        request_id: u32,
        request: shares::WithdrawalRequest,
    ) -> Result<WithdrawalQueueStatus, Error> {
        let owner: Address = env
            .storage()
            .persistent()
            .get(&VaultKey::WithdrawalOwner(request_id))
            .ok_or(Error::WithdrawalNotFound)?;
        let destination: Address = env
            .storage()
            .persistent()
            .get(&VaultKey::WithdrawalDestination(request_id))
            .unwrap_or(owner.clone());
        let claimable_assets = request
            .assets_paid
            .checked_sub(request.assets_claimed)
            .ok_or(Error::MathOverflow)?;
        let remaining_assets = request
            .assets_owed
            .checked_sub(request.assets_paid)
            .ok_or(Error::MathOverflow)?;
        Ok(WithdrawalQueueStatus {
            request_id,
            owner,
            destination,
            shares_burned: request.shares_burned,
            assets_owed: request.assets_owed,
            assets_paid: request.assets_paid,
            assets_claimed: request.assets_claimed,
            claimable_assets,
            remaining_assets,
            min_output: request.min_output,
            requested_ledger: request.requested_ledger,
            expires_ledger: request.expires_ledger,
            emergency_haircut_bps: request.emergency_haircut_bps,
            state: request.state,
        })
    }

    pub fn vault_preview_deposit(env: Env, assets: i128) -> Result<i128, Error> {
        shares::preview_deposit(&Self::load_vault(&env)?, assets)
    }

    pub fn vault_preview_redeem(env: Env, shares_amount: i128) -> Result<i128, Error> {
        shares::preview_redeem(&Self::load_vault(&env)?, shares_amount)
    }

    pub fn vault_preview_mint(env: Env, shares_amount: i128) -> Result<i128, Error> {
        shares::preview_mint(&Self::load_vault(&env)?, shares_amount)
    }

    pub fn vault_preview_withdraw(env: Env, assets: i128) -> Result<i128, Error> {
        shares::preview_withdraw(&Self::load_vault(&env)?, assets)
    }

    pub fn vault_deposit(
        env: Env,
        who: Address,
        assets: i128,
        expected_version: u64,
    ) -> Result<i128, Error> {
        who.require_auth();
        Self::ensure_vault_unpaused(&env)?;
        Self::check_vault_accounting_allowed(&env)?;
        let mut snapshot = Self::load_vault(&env)?;
        if snapshot.version != expected_version {
            return Err(Error::StaleSnapshot);
        }
        Self::checkpoint_fees(&env, &mut snapshot)?;
        // Already validated above — checkpoint_fees' own version bumps must not re-trip this.
        let post_checkpoint_version = snapshot.version;
        let receipt = shares::deposit(&mut snapshot, assets, post_checkpoint_version)?;

        let balance_key = VaultKey::ShareBalance(who.clone());
        let balance: i128 = env.storage().persistent().get(&balance_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&balance_key, &(balance + receipt.shares_minted));

        Self::save_vault(&env, &snapshot);
        env.events().publish(
            (symbol_short!("vault"), symbol_short!("deposit")),
            (who, assets, receipt.shares_minted, snapshot.version),
        );
        Ok(receipt.shares_minted)
    }

    pub fn vault_request_withdrawal(
        env: Env,
        who: Address,
        shares_amount: i128,
        expected_version: u64,
    ) -> Result<u32, Error> {
        Self::vault_request_withdrawal_to(
            env,
            who.clone(),
            who,
            shares_amount,
            0,
            0,
            expected_version,
        )
    }

    pub fn vault_request_withdrawal_to(
        env: Env,
        who: Address,
        destination: Address,
        shares_amount: i128,
        min_output: i128,
        expiry_ledgers: u32,
        expected_version: u64,
    ) -> Result<u32, Error> {
        who.require_auth();
        Self::ensure_vault_unpaused(&env)?;
        let mut snapshot = Self::load_vault(&env)?;
        if snapshot.version != expected_version {
            return Err(Error::StaleSnapshot);
        }
        Self::checkpoint_fees(&env, &mut snapshot)?;

        let balance_key = VaultKey::ShareBalance(who.clone());
        let balance: i128 = env.storage().persistent().get(&balance_key).unwrap_or(0);
        if shares_amount > balance {
            return Err(Error::InsufficientShares);
        }

        // Already validated above — checkpoint_fees' own version bumps must not re-trip this.
        let post_checkpoint_version = snapshot.version;
        let requested_ledger = env.ledger().sequence();
        let expires_ledger = if expiry_ledgers == 0 {
            0
        } else {
            requested_ledger
                .checked_add(expiry_ledgers)
                .ok_or(Error::MathOverflow)?
        };
        let request = shares::request_withdrawal_with_controls(
            &mut snapshot,
            shares_amount,
            min_output,
            requested_ledger,
            expires_ledger,
            post_checkpoint_version,
        )?;
        env.storage()
            .persistent()
            .set(&balance_key, &(balance - shares_amount));

        let nonce: u32 = env
            .storage()
            .instance()
            .get(&VaultKey::WithdrawalNonce)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&VaultKey::WithdrawalNonce, &(nonce + 1));
        env.storage()
            .persistent()
            .set(&VaultKey::WithdrawalRequest(nonce), &request);
        env.storage()
            .persistent()
            .set(&VaultKey::WithdrawalOwner(nonce), &who);
        env.storage()
            .persistent()
            .set(&VaultKey::WithdrawalDestination(nonce), &destination);
        let mut queue = Self::withdrawal_queue(&env);
        queue.push_back(nonce);
        env.storage()
            .instance()
            .set(&VaultKey::WithdrawalQueue, &queue);

        Self::save_vault(&env, &snapshot);
        env.events().publish(
            (symbol_short!("vault"), symbol_short!("q_req")),
            (who, destination, nonce, shares_amount, request.assets_owed),
        );
        Ok(nonce)
    }

    pub fn vault_fulfill_withdrawal(
        env: Env,
        caller: Address,
        request_id: u32,
        amount: i128,
    ) -> Result<i128, Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        Self::ensure_vault_unpaused(&env)?;
        if Some(request_id) != Self::first_queued_request(&env) {
            return Err(Error::QueueBlocked);
        }

        let mut request: shares::WithdrawalRequest = env
            .storage()
            .persistent()
            .get(&VaultKey::WithdrawalRequest(request_id))
            .ok_or(Error::WithdrawalNotFound)?;
        let mut snapshot = Self::load_vault(&env)?;
        if Self::maybe_expire_request(&env, &mut snapshot, request_id, &mut request)? {
            env.storage()
                .persistent()
                .set(&VaultKey::WithdrawalRequest(request_id), &request);
            Self::save_vault(&env, &snapshot);
            return Err(Error::DeadlinePassed);
        }
        let paid = shares::fulfill_withdrawal(&mut snapshot, &mut request, amount)?;

        env.storage()
            .persistent()
            .set(&VaultKey::WithdrawalRequest(request_id), &request);
        if Self::is_terminal_withdrawal(&request) {
            Self::refresh_withdrawal_head(&env);
        }
        Self::save_vault(&env, &snapshot);
        env.events().publish(
            (symbol_short!("vault"), symbol_short!("q_fulfill")),
            (request_id, paid, request.assets_owed - request.assets_paid),
        );
        Ok(paid)
    }

    pub fn vault_process_withdrawal_batch(
        env: Env,
        caller: Address,
        available_assets: i128,
        max_requests: u32,
    ) -> Result<(u32, i128), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        Self::ensure_vault_unpaused(&env)?;
        if available_assets <= 0 || max_requests == 0 {
            return Err(Error::InvalidAmount);
        }

        let queue = Self::withdrawal_queue(&env);
        let mut head = Self::queue_head(&env);
        let mut snapshot = Self::load_vault(&env)?;
        let mut remaining_budget = available_assets;
        let mut processed = 0u32;
        let mut total_paid = 0i128;

        while head < queue.len() && processed < max_requests && remaining_budget > 0 {
            let request_id = queue.get_unchecked(head);
            let mut request: shares::WithdrawalRequest = match env
                .storage()
                .persistent()
                .get(&VaultKey::WithdrawalRequest(request_id))
            {
                Some(request) => request,
                None => {
                    head += 1;
                    continue;
                }
            };

            if Self::is_terminal_withdrawal(&request) {
                head += 1;
                continue;
            }

            processed += 1;
            if Self::maybe_expire_request(&env, &mut snapshot, request_id, &mut request)? {
                env.storage()
                    .persistent()
                    .set(&VaultKey::WithdrawalRequest(request_id), &request);
                head += 1;
                continue;
            }

            let remaining_owed = request
                .assets_owed
                .checked_sub(request.assets_paid)
                .ok_or(Error::MathOverflow)?;
            let pay = remaining_budget
                .min(remaining_owed)
                .min(snapshot.total_assets);
            if pay <= 0 {
                break;
            }
            let paid = shares::fulfill_withdrawal(&mut snapshot, &mut request, pay)?;
            remaining_budget = remaining_budget
                .checked_sub(paid)
                .ok_or(Error::MathOverflow)?;
            total_paid = total_paid.checked_add(paid).ok_or(Error::MathOverflow)?;
            env.storage()
                .persistent()
                .set(&VaultKey::WithdrawalRequest(request_id), &request);
            env.events().publish(
                (symbol_short!("vault"), symbol_short!("q_fulfill")),
                (request_id, paid, request.assets_owed - request.assets_paid),
            );
            if Self::is_terminal_withdrawal(&request) {
                head += 1;
            }
        }

        Self::save_withdrawal_head(&env, head);
        Self::save_vault(&env, &snapshot);
        Ok((processed, total_paid))
    }

    pub fn vault_claim_withdrawal(
        env: Env,
        caller: Address,
        request_id: u32,
    ) -> Result<i128, Error> {
        caller.require_auth();
        let owner: Address = env
            .storage()
            .persistent()
            .get(&VaultKey::WithdrawalOwner(request_id))
            .ok_or(Error::WithdrawalNotFound)?;
        let destination: Address = env
            .storage()
            .persistent()
            .get(&VaultKey::WithdrawalDestination(request_id))
            .unwrap_or(owner.clone());
        if caller != owner && caller != destination {
            Self::require_signer(&env, &caller)?;
        }
        let mut request: shares::WithdrawalRequest = env
            .storage()
            .persistent()
            .get(&VaultKey::WithdrawalRequest(request_id))
            .ok_or(Error::WithdrawalNotFound)?;
        let claimed = shares::claim_withdrawal(&mut request)?;
        env.storage()
            .persistent()
            .set(&VaultKey::WithdrawalRequest(request_id), &request);
        env.events().publish(
            (symbol_short!("vault"), symbol_short!("q_claim")),
            (request_id, destination, claimed),
        );
        Ok(claimed)
    }

    pub fn vault_cancel_withdrawal(
        env: Env,
        caller: Address,
        request_id: u32,
    ) -> Result<i128, Error> {
        caller.require_auth();
        Self::ensure_vault_unpaused(&env)?;
        let owner: Address = env
            .storage()
            .persistent()
            .get(&VaultKey::WithdrawalOwner(request_id))
            .ok_or(Error::WithdrawalNotFound)?;
        if caller != owner {
            Self::require_signer(&env, &caller)?;
        }

        let mut request: shares::WithdrawalRequest = env
            .storage()
            .persistent()
            .get(&VaultKey::WithdrawalRequest(request_id))
            .ok_or(Error::WithdrawalNotFound)?;
        let mut snapshot = Self::load_vault(&env)?;
        let restored = shares::cancel_withdrawal(&mut snapshot, &mut request)?;
        let balance_key = VaultKey::ShareBalance(owner.clone());
        let balance: i128 = env.storage().persistent().get(&balance_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&balance_key, &(balance + restored));
        env.storage()
            .persistent()
            .set(&VaultKey::WithdrawalRequest(request_id), &request);
        if Self::is_terminal_withdrawal(&request) {
            Self::refresh_withdrawal_head(&env);
        }
        Self::save_vault(&env, &snapshot);
        env.events().publish(
            (symbol_short!("vault"), symbol_short!("q_cancel")),
            (request_id, owner, restored),
        );
        Ok(restored)
    }

    pub fn vault_expire_withdrawal(
        env: Env,
        caller: Address,
        request_id: u32,
    ) -> Result<i128, Error> {
        caller.require_auth();
        let owner: Address = env
            .storage()
            .persistent()
            .get(&VaultKey::WithdrawalOwner(request_id))
            .ok_or(Error::WithdrawalNotFound)?;
        if caller != owner {
            Self::require_signer(&env, &caller)?;
        }

        let mut request: shares::WithdrawalRequest = env
            .storage()
            .persistent()
            .get(&VaultKey::WithdrawalRequest(request_id))
            .ok_or(Error::WithdrawalNotFound)?;
        if request.expires_ledger == 0 || env.ledger().sequence() <= request.expires_ledger {
            return Err(Error::DeadlineNotReached);
        }
        let mut snapshot = Self::load_vault(&env)?;
        let restored = shares::expire_withdrawal(&mut snapshot, &mut request)?;
        let balance_key = VaultKey::ShareBalance(owner.clone());
        let balance: i128 = env.storage().persistent().get(&balance_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&balance_key, &(balance + restored));
        env.storage()
            .persistent()
            .set(&VaultKey::WithdrawalRequest(request_id), &request);
        Self::refresh_withdrawal_head(&env);
        Self::save_vault(&env, &snapshot);
        env.events().publish(
            (symbol_short!("vault"), symbol_short!("q_expire")),
            (request_id, owner, restored),
        );
        Ok(restored)
    }

    /// Deprecated single-signer entrypoint — now gated: creates a proposal that
    /// requires quorum before taking effect. Returns the proposal id. (#107)
    pub fn vault_apply_emergency_haircut(
        env: Env,
        caller: Address,
        request_id: u32,
        haircut_bps: u32,
    ) -> Result<u32, Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        Self::propose(
            env,
            caller,
            ProposalAction::VaultApplyEmergencyHaircut(request_id, haircut_bps),
        )
    }

    pub fn vault_set_paused(env: Env, caller: Address, paused: bool) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        env.storage()
            .instance()
            .set(&VaultKey::VaultPaused, &paused);
        env.events()
            .publish((symbol_short!("vault"), symbol_short!("pause")), paused);
        Ok(())
    }

    pub fn vault_accrue_management_fee(env: Env, caller: Address) -> Result<i128, Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        let mut snapshot = Self::load_vault(&env)?;
        let (management_bps, _) = Self::fee_config(&env)?;
        let fee =
            shares::accrue_management_fee(&mut snapshot, env.ledger().timestamp(), management_bps)?;
        Self::save_vault(&env, &snapshot);
        env.events().publish(
            (symbol_short!("vault"), symbol_short!("mgmtfee")),
            (fee, snapshot.version),
        );
        Ok(fee)
    }

    pub fn vault_accrue_performance_fee(env: Env, caller: Address) -> Result<i128, Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        let mut snapshot = Self::load_vault(&env)?;
        let (_, performance_bps) = Self::fee_config(&env)?;
        let fee = shares::accrue_performance_fee(&mut snapshot, performance_bps)?;
        Self::save_vault(&env, &snapshot);
        env.events().publish(
            (symbol_short!("vault"), symbol_short!("perffee")),
            (fee, snapshot.high_water_mark),
        );
        Ok(fee)
    }

    /// Deprecated single-signer entrypoint — now gated: creates a proposal that
    /// requires quorum before taking effect. Returns the proposal id. (#107)
    pub fn vault_report_gain(env: Env, caller: Address, amount: i128) -> Result<u32, Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        Self::propose(env, caller, ProposalAction::VaultReportGain(amount))
    }

    /// Deprecated single-signer entrypoint — now gated: creates a proposal that
    /// requires quorum before taking effect. Returns the proposal id. (#107)
    pub fn vault_report_loss(env: Env, caller: Address, amount: i128) -> Result<u32, Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        Self::propose(env, caller, ProposalAction::VaultReportLoss(amount))
    }

    pub fn vault_note_donation(env: Env, caller: Address, amount: i128) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        let mut snapshot = Self::load_vault(&env)?;
        shares::note_donation(&mut snapshot, amount)?;
        Self::save_vault(&env, &snapshot);
        env.events()
            .publish((symbol_short!("vault"), symbol_short!("noted")), amount);
        Ok(())
    }

    pub fn vault_recognize_donation(env: Env, caller: Address, amount: i128) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        let mut snapshot = Self::load_vault(&env)?;
        shares::recognize_donation(&mut snapshot, amount)?;
        Self::save_vault(&env, &snapshot);
        env.events()
            .publish((symbol_short!("vault"), symbol_short!("donation")), amount);
        Ok(())
    }

    pub fn vault_sweep_dust(env: Env, caller: Address) -> Result<i128, Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        let mut snapshot = Self::load_vault(&env)?;
        let amount = shares::sweep_dust(&mut snapshot)?;
        Self::save_vault(&env, &snapshot);
        let beneficiary: Address = env
            .storage()
            .instance()
            .get(&VaultKey::DustBeneficiary)
            .ok_or(Error::NotInitialized)?;
        env.events().publish(
            (symbol_short!("vault"), symbol_short!("dustswep")),
            (beneficiary, amount),
        );
        Ok(amount)
    }

    pub fn vault_claim_fees(env: Env, caller: Address, amount: i128) -> Result<(), Error> {
        caller.require_auth();
        let recipient: Address = env
            .storage()
            .instance()
            .get(&VaultKey::FeeRecipient)
            .ok_or(Error::NotInitialized)?;
        if caller != recipient {
            Self::require_signer(&env, &caller)?;
        }
        let mut snapshot = Self::load_vault(&env)?;
        shares::claim_fees(&mut snapshot, amount)?;
        Self::save_vault(&env, &snapshot);
        env.events().publish(
            (symbol_short!("vault"), symbol_short!("feeclaim")),
            (recipient, amount),
        );
        Ok(())
    }

    /// Deprecated single-signer entrypoint — now gated: creates a proposal that
    /// requires quorum before taking effect. Returns the proposal id. (#107)
    pub fn vault_set_fee_recipient(
        env: Env,
        caller: Address,
        recipient: Address,
    ) -> Result<u32, Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        Self::propose(env, caller, ProposalAction::VaultSetFeeRecipient(recipient))
    }

    pub fn vault_set_dust_beneficiary(
        env: Env,
        caller: Address,
        beneficiary: Address,
    ) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        env.storage()
            .instance()
            .set(&VaultKey::DustBeneficiary, &beneficiary);
        Ok(())
    }

    /// Deprecated single-signer entrypoint — now gated: creates a proposal that
    /// requires quorum before taking effect. Returns the proposal id. (#107)
    pub fn vault_set_management_fee_bps(env: Env, caller: Address, bps: u32) -> Result<u32, Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        Self::propose(env, caller, ProposalAction::VaultSetManagementFeeBps(bps))
    }

    /// Deprecated single-signer entrypoint — now gated: creates a proposal that
    /// requires quorum before taking effect. Returns the proposal id. (#107)
    pub fn vault_set_performance_fee_bps(env: Env, caller: Address, bps: u32) -> Result<u32, Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        Self::propose(env, caller, ProposalAction::VaultSetPerformanceFeeBps(bps))
    }

    // ── Views ──
    pub fn vault_snapshot(env: Env) -> Result<shares::VaultSnapshot, Error> {
        Self::load_vault(&env)
    }

    pub fn vault_share_balance(env: Env, who: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&VaultKey::ShareBalance(who))
            .unwrap_or(0)
    }

    pub fn vault_withdrawal_request(
        env: Env,
        request_id: u32,
    ) -> Result<shares::WithdrawalRequest, Error> {
        env.storage()
            .persistent()
            .get(&VaultKey::WithdrawalRequest(request_id))
            .ok_or(Error::WithdrawalNotFound)
    }

    pub fn vault_withdrawal_status(
        env: Env,
        request_id: u32,
    ) -> Result<WithdrawalQueueStatus, Error> {
        let request: shares::WithdrawalRequest = env
            .storage()
            .persistent()
            .get(&VaultKey::WithdrawalRequest(request_id))
            .ok_or(Error::WithdrawalNotFound)?;
        Self::withdrawal_status(&env, request_id, request)
    }

    pub fn vault_withdrawal_owner(env: Env, request_id: u32) -> Result<Address, Error> {
        env.storage()
            .persistent()
            .get(&VaultKey::WithdrawalOwner(request_id))
            .ok_or(Error::WithdrawalNotFound)
    }

    pub fn vault_withdrawal_queue(env: Env) -> Vec<u32> {
        Self::withdrawal_queue(&env)
    }

    pub fn vault_withdrawal_head(env: Env) -> u32 {
        Self::queue_head(&env)
    }

    pub fn vault_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&VaultKey::VaultPaused)
            .unwrap_or(false)
    }
}

// VaultProxy shares export names with DripPool (e.g. `create`), and a
// Soroban wasm binary can only hold one contract — deploying the proxy
// requires moving it to its own workspace crate. Until then it is compiled
// for native builds and tests only, keeping the drip-pool wasm unchanged.
pub mod vault;

pub mod shares;

#[cfg(not(target_family = "wasm"))]
pub mod proxy;

#[cfg(test)]
mod test;
