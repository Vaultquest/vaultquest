//! Transparent proxy contract for vault logic upgrades.
//!
//! Upgrades are governed by signer quorum, an observation timelock, committed
//! artifact hashes, migration checks, invariant checks, and rollback safeguards.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, vec, Address, BytesN, Env,
    Vec,
};

const UPGRADE_THRESHOLD: u32 = 2;
const MIN_UPGRADE_DELAY_LEDGERS: u32 = 17_280;

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    Signers,
    GovernanceEpoch,
    LogicContract,
    CurrentHash,
    SchemaVersion,
    StateWriteVersion,
    UpgradeNonce,
    UpgradeProposal(u32),
    LastProvenance,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    InvalidAddress = 4,
    ThresholdNotMet = 5,
    AlreadySigned = 6,
    ProposalNotFound = 7,
    TimelockActive = 8,
    HashMismatch = 9,
    StaleProposal = 10,
    MigrationSimulationFailed = 11,
    InvariantViolation = 12,
    StateDiscardBlocked = 13,
    InvalidTimelock = 14,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub enum UpgradeKind {
    Forward,
    Rollback,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct WasmProvenance {
    pub source_hash: BytesN<32>,
    pub build_recipe_hash: BytesN<32>,
    pub compiler_hash: BytesN<32>,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct UpgradeProposal {
    pub kind: UpgradeKind,
    pub logic_contract: Address,
    pub current_hash: BytesN<32>,
    pub target_hash: BytesN<32>,
    pub schema_version: u32,
    pub migration_plan_hash: BytesN<32>,
    pub migration_state_hash: BytesN<32>,
    pub earliest_ledger: u32,
    pub signer_epoch: u32,
    pub state_write_version: u32,
    pub approvals: Vec<Address>,
    pub provenance: WasmProvenance,
}

#[contract]
pub struct VaultProxy;

#[contractimpl]
impl VaultProxy {
    pub fn create(env: Env, admin: Address, logic_contract: Address) -> Result<(), Error> {
        let signers = vec![&env, admin.clone()];
        Self::create_internal(env, admin, logic_contract, signers, false)
    }

    pub fn create_governed(
        env: Env,
        admin: Address,
        logic_contract: Address,
        signers: Vec<Address>,
    ) -> Result<(), Error> {
        Self::create_internal(env, admin, logic_contract, signers, true)
    }

    fn create_internal(
        env: Env,
        admin: Address,
        logic_contract: Address,
        signers: Vec<Address>,
        enforce_quorum: bool,
    ) -> Result<(), Error> {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        if logic_contract == env.current_contract_address() {
            return Err(Error::InvalidAddress);
        }
        if !signers.contains(&admin) {
            return Err(Error::Unauthorized);
        }
        let signers = Self::unique_signers(&env, &signers)?;
        if enforce_quorum && signers.len() < UPGRADE_THRESHOLD {
            return Err(Error::ThresholdNotMet);
        }

        let zero_hash = BytesN::from_array(&env, &[0; 32]);
        let provenance = WasmProvenance {
            source_hash: zero_hash.clone(),
            build_recipe_hash: zero_hash.clone(),
            compiler_hash: zero_hash.clone(),
        };

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Signers, &signers);
        env.storage()
            .instance()
            .set(&DataKey::GovernanceEpoch, &0u32);
        env.storage()
            .instance()
            .set(&DataKey::LogicContract, &logic_contract);
        env.storage()
            .instance()
            .set(&DataKey::CurrentHash, &zero_hash);
        env.storage().instance().set(&DataKey::SchemaVersion, &1u32);
        env.storage()
            .instance()
            .set(&DataKey::StateWriteVersion, &0u32);
        env.storage().instance().set(&DataKey::UpgradeNonce, &0u32);
        env.storage()
            .instance()
            .set(&DataKey::LastProvenance, &provenance);
        env.events().publish(
            (symbol_short!("proxy"), symbol_short!("created")),
            (admin, logic_contract, zero_hash),
        );
        Ok(())
    }

    pub fn rotate_signers(
        env: Env,
        approvals: Vec<Address>,
        new_signers: Vec<Address>,
    ) -> Result<(), Error> {
        Self::require_approval_quorum(&env, &approvals)?;
        let next_signers = Self::unique_signers(&env, &new_signers)?;
        if next_signers.len() < UPGRADE_THRESHOLD {
            return Err(Error::ThresholdNotMet);
        }

        env.storage()
            .instance()
            .set(&DataKey::Signers, &next_signers);
        Self::bump_governance_epoch(&env);
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn propose_upgrade(
        env: Env,
        signer: Address,
        kind: UpgradeKind,
        logic_contract: Address,
        current_hash: BytesN<32>,
        target_hash: BytesN<32>,
        schema_version: u32,
        migration_plan_hash: BytesN<32>,
        migration_state_hash: BytesN<32>,
        earliest_ledger: u32,
        migration_compatible: bool,
        provenance: WasmProvenance,
    ) -> Result<u32, Error> {
        signer.require_auth();
        Self::require_signer(&env, &signer)?;
        if logic_contract == env.current_contract_address() {
            return Err(Error::InvalidAddress);
        }
        if !migration_compatible {
            return Err(Error::MigrationSimulationFailed);
        }

        let min_ledger = env.ledger().sequence() + MIN_UPGRADE_DELAY_LEDGERS;
        if earliest_ledger < min_ledger {
            return Err(Error::InvalidTimelock);
        }

        let stored_hash = Self::current_hash(env.clone())?;
        if current_hash != stored_hash {
            return Err(Error::StaleProposal);
        }

        let nonce = Self::upgrade_nonce(&env);
        env.storage()
            .instance()
            .set(&DataKey::UpgradeNonce, &(nonce + 1));

        let proposal = UpgradeProposal {
            kind,
            logic_contract,
            current_hash,
            target_hash,
            schema_version,
            migration_plan_hash,
            migration_state_hash,
            earliest_ledger,
            signer_epoch: Self::governance_epoch(env.clone())?,
            state_write_version: Self::state_write_version(env.clone())?,
            approvals: vec![&env, signer],
            provenance,
        };
        env.storage()
            .instance()
            .set(&DataKey::UpgradeProposal(nonce), &proposal);
        env.events().publish(
            (symbol_short!("upgrade"), symbol_short!("proposed")),
            (
                nonce,
                proposal.target_hash.clone(),
                proposal.earliest_ledger,
            ),
        );
        Ok(nonce)
    }

    pub fn approve_upgrade(env: Env, signer: Address, proposal_id: u32) -> Result<bool, Error> {
        signer.require_auth();
        Self::require_signer(&env, &signer)?;

        let mut proposal: UpgradeProposal = env
            .storage()
            .instance()
            .get(&DataKey::UpgradeProposal(proposal_id))
            .ok_or(Error::ProposalNotFound)?;

        if proposal.signer_epoch != Self::governance_epoch(env.clone())? {
            return Err(Error::StaleProposal);
        }
        if proposal.approvals.contains(&signer) {
            return Err(Error::AlreadySigned);
        }

        proposal.approvals.push_back(signer);
        let threshold_met = proposal.approvals.len() >= UPGRADE_THRESHOLD;
        env.storage()
            .instance()
            .set(&DataKey::UpgradeProposal(proposal_id), &proposal);
        env.events().publish(
            (symbol_short!("upgrade"), symbol_short!("approved")),
            (proposal_id, proposal.approvals.len()),
        );
        Ok(threshold_met)
    }

    pub fn execute_upgrade(
        env: Env,
        signer: Address,
        proposal_id: u32,
        executed_hash: BytesN<32>,
        invariants_verified: bool,
        preserve_later_writes: bool,
    ) -> Result<(), Error> {
        signer.require_auth();
        Self::require_signer(&env, &signer)?;

        let proposal: UpgradeProposal = env
            .storage()
            .instance()
            .get(&DataKey::UpgradeProposal(proposal_id))
            .ok_or(Error::ProposalNotFound)?;

        Self::verify_executable(&env, &proposal, &executed_hash, invariants_verified)?;

        if proposal.kind == UpgradeKind::Rollback
            && Self::state_write_version(env.clone())? > proposal.state_write_version
            && !preserve_later_writes
        {
            return Err(Error::StateDiscardBlocked);
        }

        env.storage()
            .instance()
            .set(&DataKey::LogicContract, &proposal.logic_contract);
        env.storage()
            .instance()
            .set(&DataKey::CurrentHash, &proposal.target_hash);
        env.storage()
            .instance()
            .set(&DataKey::SchemaVersion, &proposal.schema_version);
        env.storage()
            .instance()
            .set(&DataKey::LastProvenance, &proposal.provenance);
        env.storage()
            .instance()
            .remove(&DataKey::UpgradeProposal(proposal_id));
        env.events().publish(
            (symbol_short!("upgrade"), symbol_short!("executed")),
            (proposal_id, proposal.target_hash, proposal.schema_version),
        );
        Ok(())
    }

    pub fn record_state_write(env: Env, caller: Address) -> Result<u32, Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;

        let next = Self::state_write_version(env.clone())? + 1;
        env.storage()
            .instance()
            .set(&DataKey::StateWriteVersion, &next);
        env.events()
            .publish((symbol_short!("state"), symbol_short!("write")), next);
        Ok(next)
    }

    pub fn logic_contract(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::LogicContract)
            .ok_or(Error::NotInitialized)
    }

    pub fn admin(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }

    pub fn signers(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Signers)
            .unwrap_or(vec![&env])
    }

    pub fn governance_epoch(env: Env) -> Result<u32, Error> {
        env.storage()
            .instance()
            .get(&DataKey::GovernanceEpoch)
            .ok_or(Error::NotInitialized)
    }

    pub fn current_hash(env: Env) -> Result<BytesN<32>, Error> {
        env.storage()
            .instance()
            .get(&DataKey::CurrentHash)
            .ok_or(Error::NotInitialized)
    }

    pub fn schema_version(env: Env) -> Result<u32, Error> {
        env.storage()
            .instance()
            .get(&DataKey::SchemaVersion)
            .ok_or(Error::NotInitialized)
    }

    pub fn state_write_version(env: Env) -> Result<u32, Error> {
        env.storage()
            .instance()
            .get(&DataKey::StateWriteVersion)
            .ok_or(Error::NotInitialized)
    }

    pub fn last_provenance(env: Env) -> Result<WasmProvenance, Error> {
        env.storage()
            .instance()
            .get(&DataKey::LastProvenance)
            .ok_or(Error::NotInitialized)
    }

    pub fn upgrade_proposal(env: Env, proposal_id: u32) -> Result<UpgradeProposal, Error> {
        env.storage()
            .instance()
            .get(&DataKey::UpgradeProposal(proposal_id))
            .ok_or(Error::ProposalNotFound)
    }

    fn require_signer(env: &Env, signer: &Address) -> Result<(), Error> {
        let signers: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Signers)
            .ok_or(Error::NotInitialized)?;
        if !signers.contains(signer) {
            return Err(Error::Unauthorized);
        }
        Ok(())
    }

    fn require_approval_quorum(env: &Env, approvals: &Vec<Address>) -> Result<(), Error> {
        let signers: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Signers)
            .ok_or(Error::NotInitialized)?;
        let mut distinct = Vec::new(env);

        for approval in approvals.iter() {
            approval.require_auth();
            if !signers.contains(&approval) {
                return Err(Error::Unauthorized);
            }
            if !distinct.contains(&approval) {
                distinct.push_back(approval);
            }
        }

        if distinct.len() < UPGRADE_THRESHOLD {
            return Err(Error::ThresholdNotMet);
        }
        Ok(())
    }

    fn unique_signers(env: &Env, signers: &Vec<Address>) -> Result<Vec<Address>, Error> {
        let mut unique = Vec::new(env);
        for signer in signers.iter() {
            if !unique.contains(&signer) {
                unique.push_back(signer);
            }
        }
        if unique.len() == 0 {
            return Err(Error::Unauthorized);
        }
        Ok(unique)
    }

    fn bump_governance_epoch(env: &Env) {
        let current: u32 = env
            .storage()
            .instance()
            .get(&DataKey::GovernanceEpoch)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::GovernanceEpoch, &(current + 1));
        env.events()
            .publish((symbol_short!("gov"), symbol_short!("epoch")), current + 1);
    }

    fn upgrade_nonce(env: &Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::UpgradeNonce)
            .unwrap_or(0)
    }

    fn verify_executable(
        env: &Env,
        proposal: &UpgradeProposal,
        executed_hash: &BytesN<32>,
        invariants_verified: bool,
    ) -> Result<(), Error> {
        if proposal.approvals.len() < UPGRADE_THRESHOLD {
            return Err(Error::ThresholdNotMet);
        }
        if env.ledger().sequence() < proposal.earliest_ledger {
            return Err(Error::TimelockActive);
        }
        if proposal.signer_epoch
            != env
                .storage()
                .instance()
                .get(&DataKey::GovernanceEpoch)
                .ok_or(Error::NotInitialized)?
        {
            return Err(Error::StaleProposal);
        }
        if proposal.current_hash != Self::current_hash(env.clone())? {
            return Err(Error::StaleProposal);
        }
        if *executed_hash != proposal.target_hash {
            return Err(Error::HashMismatch);
        }
        if !invariants_verified {
            return Err(Error::InvariantViolation);
        }
        Ok(())
    }
}
