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
    contract, contracterror, contractimpl, contracttype, symbol_short, vec, Address, Env, Vec,
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

    // ── #72: share-based NAV vault ──
    VaultShares,
    ShareBalance(Address),
    WithdrawalNonce,
    WithdrawalRequest(u32),
    WithdrawalOwner(u32),
    FeeRecipient,
    DustBeneficiary,
    ManagementFeeBps,
    PerformanceFeeBps,
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
    StaleSnapshot = 12, // NAV snapshot version moved under the caller
    RoundsToZero = 13,  // amount too small to produce a non-zero result
    InsufficientShares = 14,
    MathOverflow = 15,
    NothingToSweep = 16,
    WithdrawalNotFound = 17,
    WithdrawalAlreadySettled = 18,
    ExceedsOwed = 19,         // fulfillment amount exceeds what's still owed
    InsufficientBalance = 20, // vault-side balance can't cover this amount
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

    // ── #72: share-based NAV vault — additive, its own storage keys ──────────

    pub fn vault_init(env: Env, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        if env.storage().instance().has(&DataKey::VaultShares) {
            return Err(Error::AlreadyInitialized);
        }
        let snapshot = shares::VaultSnapshot::new(env.ledger().timestamp())?;
        env.storage()
            .instance()
            .set(&DataKey::VaultShares, &snapshot);
        env.storage()
            .instance()
            .set(&DataKey::WithdrawalNonce, &0u32);
        env.storage()
            .instance()
            .set(&DataKey::FeeRecipient, &caller);
        env.storage()
            .instance()
            .set(&DataKey::DustBeneficiary, &caller);
        env.storage()
            .instance()
            .set(&DataKey::ManagementFeeBps, &0u32);
        env.storage()
            .instance()
            .set(&DataKey::PerformanceFeeBps, &0u32);
        env.events()
            .publish((symbol_short!("vault"), symbol_short!("init")), caller);
        Ok(())
    }

    fn load_vault(env: &Env) -> Result<shares::VaultSnapshot, Error> {
        env.storage()
            .instance()
            .get(&DataKey::VaultShares)
            .ok_or(Error::NotInitialized)
    }

    fn save_vault(env: &Env, snapshot: &shares::VaultSnapshot) {
        env.storage()
            .instance()
            .set(&DataKey::VaultShares, snapshot);
    }

    fn fee_config(env: &Env) -> Result<(u32, u32), Error> {
        let management: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ManagementFeeBps)
            .ok_or(Error::NotInitialized)?;
        let performance: u32 = env
            .storage()
            .instance()
            .get(&DataKey::PerformanceFeeBps)
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
        let mut snapshot = Self::load_vault(&env)?;
        if snapshot.version != expected_version {
            return Err(Error::StaleSnapshot);
        }
        Self::checkpoint_fees(&env, &mut snapshot)?;
        // Already validated above — checkpoint_fees' own version bumps must not re-trip this.
        let post_checkpoint_version = snapshot.version;
        let receipt = shares::deposit(&mut snapshot, assets, post_checkpoint_version)?;

        let balance_key = DataKey::ShareBalance(who.clone());
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
        who.require_auth();
        let mut snapshot = Self::load_vault(&env)?;
        if snapshot.version != expected_version {
            return Err(Error::StaleSnapshot);
        }
        Self::checkpoint_fees(&env, &mut snapshot)?;

        let balance_key = DataKey::ShareBalance(who.clone());
        let balance: i128 = env.storage().persistent().get(&balance_key).unwrap_or(0);
        if shares_amount > balance {
            return Err(Error::InsufficientShares);
        }

        // Already validated above — checkpoint_fees' own version bumps must not re-trip this.
        let post_checkpoint_version = snapshot.version;
        let request =
            shares::request_withdrawal(&mut snapshot, shares_amount, post_checkpoint_version)?;
        env.storage()
            .persistent()
            .set(&balance_key, &(balance - shares_amount));

        let nonce: u32 = env
            .storage()
            .instance()
            .get(&DataKey::WithdrawalNonce)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::WithdrawalNonce, &(nonce + 1));
        env.storage()
            .persistent()
            .set(&DataKey::WithdrawalRequest(nonce), &request);
        env.storage()
            .persistent()
            .set(&DataKey::WithdrawalOwner(nonce), &who);

        Self::save_vault(&env, &snapshot);
        env.events().publish(
            (symbol_short!("vault"), symbol_short!("requested")),
            (who, nonce, shares_amount, request.assets_owed),
        );
        Ok(nonce)
    }

    /// Callable by the request's own owner (self-service) or any approved signer (batching).
    pub fn vault_fulfill_withdrawal(
        env: Env,
        caller: Address,
        request_id: u32,
        amount: i128,
    ) -> Result<i128, Error> {
        caller.require_auth();
        let owner: Address = env
            .storage()
            .persistent()
            .get(&DataKey::WithdrawalOwner(request_id))
            .ok_or(Error::WithdrawalNotFound)?;
        if caller != owner {
            Self::require_signer(&env, &caller)?;
        }

        let mut request: shares::WithdrawalRequest = env
            .storage()
            .persistent()
            .get(&DataKey::WithdrawalRequest(request_id))
            .ok_or(Error::WithdrawalNotFound)?;
        let mut snapshot = Self::load_vault(&env)?;
        let paid = shares::fulfill_withdrawal(&mut snapshot, &mut request, amount)?;

        env.storage()
            .persistent()
            .set(&DataKey::WithdrawalRequest(request_id), &request);
        Self::save_vault(&env, &snapshot);
        env.events().publish(
            (symbol_short!("vault"), symbol_short!("fulfilled")),
            (request_id, paid, request.assets_owed - request.assets_paid),
        );
        Ok(paid)
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

    pub fn vault_report_gain(env: Env, caller: Address, amount: i128) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        let mut snapshot = Self::load_vault(&env)?;
        shares::report_gain(&mut snapshot, amount)?;
        Self::save_vault(&env, &snapshot);
        env.events()
            .publish((symbol_short!("vault"), symbol_short!("gain")), amount);
        Ok(())
    }

    pub fn vault_report_loss(env: Env, caller: Address, amount: i128) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        let mut snapshot = Self::load_vault(&env)?;
        shares::report_loss(&mut snapshot, amount)?;
        Self::save_vault(&env, &snapshot);
        env.events()
            .publish((symbol_short!("vault"), symbol_short!("loss")), amount);
        Ok(())
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
            .get(&DataKey::DustBeneficiary)
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
            .get(&DataKey::FeeRecipient)
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

    pub fn vault_set_fee_recipient(
        env: Env,
        caller: Address,
        recipient: Address,
    ) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        env.storage()
            .instance()
            .set(&DataKey::FeeRecipient, &recipient);
        Ok(())
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
            .set(&DataKey::DustBeneficiary, &beneficiary);
        Ok(())
    }

    pub fn vault_set_management_fee_bps(env: Env, caller: Address, bps: u32) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        env.storage()
            .instance()
            .set(&DataKey::ManagementFeeBps, &bps);
        Ok(())
    }

    pub fn vault_set_performance_fee_bps(env: Env, caller: Address, bps: u32) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        env.storage()
            .instance()
            .set(&DataKey::PerformanceFeeBps, &bps);
        Ok(())
    }

    // ── Views ──
    pub fn vault_snapshot(env: Env) -> Result<shares::VaultSnapshot, Error> {
        Self::load_vault(&env)
    }

    pub fn vault_share_balance(env: Env, who: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::ShareBalance(who))
            .unwrap_or(0)
    }

    pub fn vault_withdrawal_request(
        env: Env,
        request_id: u32,
    ) -> Result<shares::WithdrawalRequest, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::WithdrawalRequest(request_id))
            .ok_or(Error::WithdrawalNotFound)
    }

    pub fn vault_withdrawal_owner(env: Env, request_id: u32) -> Result<Address, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::WithdrawalOwner(request_id))
            .ok_or(Error::WithdrawalNotFound)
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
