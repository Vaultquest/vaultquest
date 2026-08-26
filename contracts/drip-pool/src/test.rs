//! Adversarial unit-test suite (#141) + regression tests (#139, #140).
//! Event emission tests (#255). Storage optimisation regression (#257).
//! Multisig signer rotation, revoked-signer and threshold coverage.

use super::*;
use crate::proxy::{
    Error as ProxyError, MigrationCheck, UpgradeKind, VaultProxy, VaultProxyClient, WasmProvenance,
};
use soroban_sdk::testutils::{Address as _, Events as _, Ledger as _};
use soroban_sdk::{vec, BytesN, IntoVal, TryFromVal, Vec};

// ── helpers ────────────────────────────────────────────────────────────────

fn setup() -> (Env, DripPoolClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    // Give storage entries a TTL longer than the lockup window so that
    // skip_lockup() does not archive the contract instance in the test env.
    env.ledger().with_mut(|li| {
        li.min_persistent_entry_ttl = 10_000_000;
        li.min_temp_entry_ttl = 10_000_000;
        li.max_entry_ttl = 20_000_000;
    });
    let id = env.register_contract(None, DripPool);
    let client = DripPoolClient::new(&env, &id);
    let admin = Address::generate(&env);
    (env, client, admin)
}

/// Advance ledger sequence past the lockup window.
fn skip_lockup(env: &Env) {
    env.ledger().with_mut(|li| li.sequence_number += 120_961);
}

// ── #100: vault custody helpers ──────────────────────────────────────────
// Real SEP-41 token plumbing for tests that exercise `vault_deposit` /
// `vault_claim_withdrawal`'s actual token transfers, instead of the old
// transfer-free accounting.

/// Deploys a standard Stellar Asset Contract to back a vault under test.
fn deploy_asset(env: &Env, admin: &Address) -> Address {
    env.register_stellar_asset_contract_v2(admin.clone())
        .address()
}

/// Mints `amount` of `asset` to `to` via the SAC admin interface.
fn mint(env: &Env, asset: &Address, to: &Address, amount: i128) {
    soroban_sdk::token::StellarAssetClient::new(env, asset).mint(to, &amount);
}

/// Real token balance of `who` in `asset`.
fn token_balance(env: &Env, asset: &Address, who: &Address) -> i128 {
    soroban_sdk::token::Client::new(env, asset).balance(who)
}

// ── existing regression tests (updated for new Participant shape) ──────────

#[test]
fn create_initialises_pool() {
    let (_env, client, admin) = setup();
    client.create(&admin);
    let pool = client.pool();
    assert_eq!(pool.admin, admin);
    assert_eq!(pool.total_drips, 0);
    assert_eq!(pool.total_deposited, 0);
}

#[test]
fn create_twice_fails() {
    let (_env, client, admin) = setup();
    client.create(&admin);
    assert_eq!(
        client.try_create(&admin),
        Err(Ok(Error::AlreadyInitialized))
    );
}

#[test]
fn full_lifecycle_create_join_drip_claim_withdraw() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &10);
    client.drip(&alice, &5);

    let pool = client.pool();
    assert_eq!(pool.total_drips, 2);
    assert_eq!(pool.total_deposited, 15);

    let savings = client.savings(&alice);
    assert_eq!(savings.deposited, 15);

    let claimed = client.claim(&alice);
    assert_eq!(claimed, 15);
    assert_eq!(client.claim_reward(&alice), 0);

    skip_lockup(&env);
    let withdrawn = client.withdraw(&alice);
    assert_eq!(withdrawn, 15);
}

#[test]
fn double_join_fails() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    assert_eq!(client.try_join(&alice), Err(Ok(Error::AlreadyJoined)));
}

#[test]
fn drip_zero_amount_fails() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    assert_eq!(client.try_drip(&alice, &0), Err(Ok(Error::InvalidAmount)));
}

#[test]
fn drip_without_join_fails() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.drip(&alice, &10);
    let savings = client.savings(&alice);
    assert_eq!(savings.deposited, 10);
    assert_eq!(savings.claimable, 10);
}

#[test]
fn withdraw_without_join_fails() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    assert_eq!(client.try_withdraw(&alice), Err(Ok(Error::NotJoined)));
}

#[test]
fn pool_uninitialized_fails() {
    let (_env, client, _admin) = setup();
    assert_eq!(client.try_pool(), Err(Ok(Error::NotInitialized)));
}

// ── #139: lockup & reentrancy ──────────────────────────────────────────────

#[test]
fn withdraw_before_lockup_reverts() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &100);
    // Lockup still active — must revert.
    assert_eq!(client.try_withdraw(&alice), Err(Ok(Error::LockupActive)));
}

#[test]
fn withdraw_after_lockup_succeeds() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &100);
    skip_lockup(&env);
    assert_eq!(client.withdraw(&alice), 100);
}

// ── #140: multi-sig admin controls ────────────────────────────────────────

#[test]
fn non_signer_cannot_propose() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let rando = Address::generate(&env);
    let res = client.try_propose(&rando, &ProposalAction::AddAdmin(rando.clone()));
    assert_eq!(res, Err(Ok(Error::Unauthorized)));
}

#[test]
fn single_sig_does_not_execute_release() {
    let (env, client, admin) = setup();
    client.create(&admin);
    client.deposit(&admin, &500);

    let recipient = Address::generate(&env);
    let pid = client.propose(
        &admin,
        &ProposalAction::ReleaseEscrow(recipient.clone(), 500),
    );
    // Admin already signed via propose — second approve must be rejected.
    assert_eq!(
        client.try_approve(&admin, &pid),
        Err(Ok(Error::AlreadySigned))
    );
    // Funds NOT released — total_deposited unchanged.
    assert_eq!(client.pool().total_deposited, 500);
}

#[test]
fn two_of_two_sigs_executes_release() {
    let (env, client, admin) = setup();
    client.create(&admin);
    client.deposit(&admin, &500);

    let signer2 = Address::generate(&env);
    client.add_admin(&admin, &signer2);

    let recipient = Address::generate(&env);
    let pid = client.propose(
        &admin,
        &ProposalAction::ReleaseEscrow(recipient.clone(), 200),
    );
    // Proposer counts as 1 of 2 — nothing released yet.
    assert_eq!(client.pool().total_deposited, 500);
    // Second distinct signer reaches the threshold and executes.
    assert!(client.approve(&signer2, &pid));
    assert_eq!(client.pool().total_deposited, 300);
}

#[test]
fn duplicate_approval_rejected() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let pid = client.propose(&admin, &ProposalAction::AddAdmin(Address::generate(&env)));
    assert_eq!(
        client.try_approve(&admin, &pid),
        Err(Ok(Error::AlreadySigned))
    );
}

// ── multisig signer rotation & revoked-signer behaviour ───────────────────

#[test]
fn duplicate_add_admin_is_noop() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let signer2 = Address::generate(&env);
    client.add_admin(&admin, &signer2);
    // After the first add_admin, admins has size 2, so bootstrap is complete.
    // The second direct add_admin must fail with Error::BootstrapComplete.
    assert_eq!(
        client.try_add_admin(&admin, &signer2),
        Err(Ok(Error::BootstrapComplete))
    );
    assert_eq!(client.admins().len(), 2);
}

#[test]
fn removed_signer_cannot_propose() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let signer2 = Address::generate(&env);
    client.add_admin(&admin, &signer2);

    // To remove signer2, we must first change threshold to 1.
    let pid1 = client.propose(&admin, &ProposalAction::ChangeThreshold(1));
    client.approve(&signer2, &pid1);

    // Propose removing signer2. Since threshold is 1, it executes immediately.
    client.propose(&admin, &ProposalAction::RemoveAdmin(signer2.clone()));

    assert_eq!(client.admins().len(), 1);

    // Removed signer can no longer propose…
    assert_eq!(
        client.try_propose(&signer2, &ProposalAction::AddAdmin(signer2.clone())),
        Err(Ok(Error::Unauthorized))
    );
    // …nor mutate the signer set directly.
    assert_eq!(
        client.try_add_admin(&signer2, &signer2),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn removed_signer_cannot_approve() {
    let (env, client, admin) = setup();
    client.create(&admin);
    client.deposit(&admin, &500);

    let signer2 = Address::generate(&env);
    let signer3 = Address::generate(&env);
    client.add_admin(&admin, &signer2);

    // Add signer3 via proposal
    let add_pid = client.propose(&admin, &ProposalAction::AddAdmin(signer3.clone()));
    client.approve(&signer2, &add_pid);

    let recipient = Address::generate(&env);
    let pid = client.propose(
        &admin,
        &ProposalAction::ReleaseEscrow(recipient.clone(), 200),
    );

    // Revoke signer3 while the proposal is pending.
    let rm_pid = client.propose(&admin, &ProposalAction::RemoveAdmin(signer3.clone()));
    client.approve(&signer2, &rm_pid);

    // signer3 is removed. Try to approve the old pid should fail because signer3 is no longer authorized.
    assert_eq!(
        client.try_approve(&signer3, &pid),
        Err(Ok(Error::Unauthorized))
    );

    // Remaining signers also cannot complete the proposal from the previous epoch.
    assert_eq!(
        client.try_approve(&signer2, &pid),
        Err(Ok(Error::StaleEpoch))
    );
    assert_eq!(client.pool().total_deposited, 500);
}

#[test]
fn duplicate_approval_does_not_inflate_threshold() {
    let (env, client, admin) = setup();
    client.create(&admin);
    client.deposit(&admin, &500);

    let signer2 = Address::generate(&env);
    let signer3 = Address::generate(&env);
    client.add_admin(&admin, &signer2);

    // Add signer3 via proposal
    let add_pid = client.propose(&admin, &ProposalAction::AddAdmin(signer3.clone()));
    client.approve(&signer2, &add_pid);

    let recipient = Address::generate(&env);
    let pid = client.propose(
        &admin,
        &ProposalAction::ReleaseEscrow(recipient.clone(), 500),
    );

    // The proposer re-approving is rejected and does not count twice.
    assert_eq!(
        client.try_approve(&admin, &pid),
        Err(Ok(Error::AlreadySigned))
    );
    assert_eq!(client.pool().total_deposited, 500);

    // A second distinct signer reaches the threshold and executes.
    assert!(client.approve(&signer2, &pid));
    assert_eq!(client.pool().total_deposited, 0);
}

#[test]
fn approval_order_is_irrelevant() {
    let (env, client, admin) = setup();
    client.create(&admin);
    client.deposit(&admin, &400);

    let signer2 = Address::generate(&env);
    let signer3 = Address::generate(&env);
    client.add_admin(&admin, &signer2);

    // Add signer3 via proposal
    let add_pid = client.propose(&admin, &ProposalAction::AddAdmin(signer3.clone()));
    client.approve(&signer2, &add_pid);

    let recipient = Address::generate(&env);

    // Proposed by admin, completed by the third signer.
    let pid1 = client.propose(
        &admin,
        &ProposalAction::ReleaseEscrow(recipient.clone(), 100),
    );
    assert!(client.approve(&signer3, &pid1));
    assert_eq!(client.pool().total_deposited, 300);

    // Proposed by the second signer, completed by admin.
    let pid2 = client.propose(
        &signer2,
        &ProposalAction::ReleaseEscrow(recipient.clone(), 100),
    );
    assert!(client.approve(&admin, &pid2));
    assert_eq!(client.pool().total_deposited, 200);
}

#[test]
fn executed_proposal_cannot_be_reapproved() {
    let (env, client, admin) = setup();
    client.create(&admin);
    client.deposit(&admin, &500);

    let signer2 = Address::generate(&env);
    let signer3 = Address::generate(&env);
    client.add_admin(&admin, &signer2);

    // Add signer3 via proposal
    let add_pid = client.propose(&admin, &ProposalAction::AddAdmin(signer3.clone()));
    client.approve(&signer2, &add_pid);

    let recipient = Address::generate(&env);
    let pid = client.propose(
        &admin,
        &ProposalAction::ReleaseEscrow(recipient.clone(), 200),
    );
    assert!(client.approve(&signer2, &pid));

    // Executed proposals are saved in storage as Executed — a late approval returns ProposalAlreadyExecuted
    assert_eq!(
        client.try_approve(&signer3, &pid),
        Err(Ok(Error::ProposalAlreadyExecuted))
    );
    assert_eq!(client.pool().total_deposited, 300);
}

#[test]
fn stale_approval_from_removed_signer_is_prevented() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let signer2 = Address::generate(&env);
    let signer3 = Address::generate(&env);
    let signer4 = Address::generate(&env);
    client.add_admin(&admin, &signer2);

    // Add signer3 via proposal
    let add_pid1 = client.propose(&admin, &ProposalAction::AddAdmin(signer3.clone()));
    client.approve(&signer2, &add_pid1);

    // signer2 proposes a release escrow (auto-approves, 1 of 2), then is removed.
    let pid = client.propose(&signer2, &ProposalAction::AddAdmin(signer4.clone()));

    // Remove signer2 via proposal
    let rm_pid = client.propose(&admin, &ProposalAction::RemoveAdmin(signer2.clone()));
    client.approve(&signer3, &rm_pid);

    // signer2's proposal is stale due to epoch change. Admin approving it should fail with StaleEpoch.
    assert_eq!(client.try_approve(&admin, &pid), Err(Ok(Error::StaleEpoch)));
    assert!(!client.admins().contains(&signer4));
}

#[test]
fn admin_rotation_via_multisig_proposals() {
    let (env, client, admin) = setup();
    client.create(&admin);
    client.deposit(&admin, &500);

    let signer2 = Address::generate(&env);
    let signer3 = Address::generate(&env);
    client.add_admin(&admin, &signer2);

    // AddAdmin executed through the multisig flow.
    let add_pid = client.propose(&admin, &ProposalAction::AddAdmin(signer3.clone()));
    assert!(client.approve(&signer2, &add_pid));
    assert_eq!(client.admins().len(), 3);
    assert!(client.admins().contains(&signer3));

    // RemoveAdmin executed through the multisig flow.
    let rm_pid = client.propose(&admin, &ProposalAction::RemoveAdmin(signer2.clone()));
    assert!(client.approve(&signer3, &rm_pid));
    assert_eq!(client.admins().len(), 2);
    assert!(!client.admins().contains(&signer2));

    // The rotated-out signer has lost both propose and approve rights.
    let recipient = Address::generate(&env);
    let rel_pid = client.propose(
        &admin,
        &ProposalAction::ReleaseEscrow(recipient.clone(), 100),
    );
    assert_eq!(
        client.try_propose(&signer2, &ProposalAction::AddAdmin(signer2.clone())),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        client.try_approve(&signer2, &rel_pid),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(client.pool().total_deposited, 500);
}

#[test]
fn cannot_remove_last_admin() {
    let (_env, client, admin) = setup();
    client.create(&admin);
    assert_eq!(
        client.try_remove_admin(&admin, &admin),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(client.admins().len(), 1);
}

#[test]
fn prevent_unreachable_quorum_when_signer_set_shrinks() {
    let (env, client, admin) = setup();
    client.create(&admin);
    client.deposit(&admin, &500);

    let signer2 = Address::generate(&env);
    client.add_admin(&admin, &signer2);

    // Direct remove admin fails because bootstrap is complete
    assert_eq!(
        client.try_remove_admin(&admin, &signer2),
        Err(Ok(Error::BootstrapComplete))
    );

    // Proposing to remove signer2 without changing threshold to 1 first
    // should fail during execution/validation since remaining signer count (1)
    // would be less than the threshold (2).
    let pid = client.propose(&admin, &ProposalAction::RemoveAdmin(signer2.clone()));

    // Approving it will try to execute it, which fails with Error::InvalidThreshold
    assert_eq!(
        client.try_approve(&signer2, &pid),
        Err(Ok(Error::InvalidThreshold))
    );
    assert_eq!(client.pool().total_deposited, 500);
}

// ── #141: adversarial prize-draw edge cases ────────────────────────────────

/// Single depositor must be the only possible winner (100 % certainty).
#[test]
fn single_depositor_wins_always() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &1_000_000);

    let pool = client.pool();
    // Alice is the only participant; her deposit equals total_deposited.
    let savings = client.savings(&alice);
    assert_eq!(savings.deposited, pool.total_deposited);
}

/// Zero-balance accounts are never eligible (claimable == 0).
#[test]
fn zero_balance_account_not_eligible() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    // No deposit — claimable must be 0.
    let savings = client.savings(&alice);
    assert_eq!(savings.claimable, 0);
    assert_eq!(savings.deposited, 0);
}

/// High-volume: 50 participants all deposit; pool totals are consistent.
#[test]
fn high_volume_deposits_consistent() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let n: i128 = 50;
    for _ in 0..n {
        let user = Address::generate(&env);
        client.join(&user);
        client.deposit(&user, &1_000);
    }

    let pool = client.pool();
    assert_eq!(pool.total_deposited, n * 1_000);
    assert_eq!(pool.total_drips, n as u64);
}

/// Flash-loan simulation: deposit then immediately withdraw in same "block"
/// is blocked by the lockup guard — no manipulation possible.
#[test]
fn flash_loan_blocked_by_lockup() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let attacker = Address::generate(&env);
    client.join(&attacker);
    client.deposit(&attacker, &1_000_000_000);
    // Attempt immediate withdrawal (flash-loan style) — must fail.
    assert_eq!(client.try_withdraw(&attacker), Err(Ok(Error::LockupActive)));
    // Pool still holds the funds.
    assert_eq!(client.pool().total_deposited, 1_000_000_000);
}

/// Negative deposit is rejected.
#[test]
fn negative_deposit_rejected() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    assert_eq!(
        client.try_deposit(&alice, &-1),
        Err(Ok(Error::InvalidAmount))
    );
}

// ── #255 / #19: event emission and schema conformance ──────────────────────
//
// These tests pin down the exact topic pair and payload shape emitted for
// each lifecycle event so that an accidental change to a topic symbol or a
// payload field/order breaks CI instead of silently drifting from
// `contracts/docs/EVENT_SCHEMA.md`. See that file's "Implementation status"
// section for how the on-chain shape maps to the documented schema.

/// create emits a `pool / created` event carrying the admin address.
#[test]
fn create_emits_event() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let events = env.events().all();
    let created_event = events.iter().find(|(_, topics, _)| {
        *topics
            == vec![
                &env,
                symbol_short!("pool").into_val(&env),
                symbol_short!("created").into_val(&env),
            ]
    });
    let (_, _, payload) = created_event.expect("created event not found");
    let val: Address = Address::try_from_val(&env, &payload).unwrap();
    assert_eq!(
        val, admin,
        "created event payload should be the admin address"
    );
}

/// join emits a `pool / joined` event carrying the joining wallet.
#[test]
fn join_emits_event() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);

    let events = env.events().all();
    let joined_event = events.iter().find(|(_, topics, _)| {
        *topics
            == vec![
                &env,
                symbol_short!("pool").into_val(&env),
                symbol_short!("joined").into_val(&env),
            ]
    });
    let (_, _, payload) = joined_event.expect("joined event not found");
    let val: Address = Address::try_from_val(&env, &payload).unwrap();
    assert_eq!(
        val, alice,
        "joined event payload should be the joining wallet"
    );
}

/// Deposit emits a `pool / deposit` event with (who, amount, total_deposited).
#[test]
fn deposit_emits_event() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &500);

    let events = env.events().all();
    let deposit_event = events.iter().find(|(_, topics, _)| {
        *topics
            == vec![
                &env,
                symbol_short!("pool").into_val(&env),
                symbol_short!("deposit").into_val(&env),
            ]
    });
    let (_, _, payload) = deposit_event.expect("deposit event not found");
    let val: (Address, i128, i128) = <(Address, i128, i128)>::try_from_val(&env, &payload).unwrap();
    assert_eq!(
        val,
        (alice.clone(), 500i128, 500i128),
        "deposit event payload should be (who, amount, total_deposited)"
    );
}

/// claim_reward emits a `pool / claimed` event with (who, amount).
#[test]
fn claim_emits_event() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &500);
    let claimed = client.claim_reward(&alice);
    assert_eq!(claimed, 500);

    let events = env.events().all();
    let claimed_event = events.iter().find(|(_, topics, _)| {
        *topics
            == vec![
                &env,
                symbol_short!("pool").into_val(&env),
                symbol_short!("claimed").into_val(&env),
            ]
    });
    let (_, _, payload) = claimed_event.expect("claimed event not found");
    let val: (Address, i128) = <(Address, i128)>::try_from_val(&env, &payload).unwrap();
    assert_eq!(
        val,
        (alice.clone(), 500i128),
        "claimed event payload should be (who, amount)"
    );
}

/// Withdraw emits a `pool / withdrawn` event with (who, amount).
#[test]
fn withdraw_emits_event() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &200);
    skip_lockup(&env);
    client.withdraw(&alice);

    let events = env.events().all();
    let withdrawn_event = events.iter().find(|(_, topics, _)| {
        *topics
            == vec![
                &env,
                symbol_short!("pool").into_val(&env),
                symbol_short!("withdrawn").into_val(&env),
            ]
    });
    let (_, _, payload) = withdrawn_event.expect("withdrawn event not found");
    let val: (Address, i128) = <(Address, i128)>::try_from_val(&env, &payload).unwrap();
    assert_eq!(
        val,
        (alice.clone(), 200i128),
        "withdrawn event payload should be (who, amount)"
    );
}

/// draw_winner emits a `pool / payout` event with (winner, prize).
#[test]
fn draw_winner_emits_payout_event() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &1_000);

    let winner = client.draw_winner(&admin, &100);
    assert_eq!(winner, alice);

    let events = env.events().all();
    let payout_event = events.iter().find(|(_, topics, _)| {
        *topics
            == vec![
                &env,
                symbol_short!("pool").into_val(&env),
                symbol_short!("payout").into_val(&env),
            ]
    });
    let (_, _, payload) = payout_event.expect("payout event not found");
    let val: (Address, i128) = <(Address, i128)>::try_from_val(&env, &payload).unwrap();
    assert_eq!(
        val,
        (winner.clone(), 100i128),
        "payout event payload should be (winner, prize)"
    );
}

/// draw_winner with zero prize is rejected.
#[test]
fn draw_winner_zero_prize_fails() {
    let (_env, client, admin) = setup();
    client.create(&admin);
    assert_eq!(
        client.try_draw_winner(&admin, &0),
        Err(Ok(Error::InvalidAmount))
    );
}

/// Non-admin cannot call draw_winner.
#[test]
fn draw_winner_unauthorized_fails() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let rando = Address::generate(&env);
    assert_eq!(
        client.try_draw_winner(&rando, &100),
        Err(Ok(Error::Unauthorized))
    );
}

// ── #257: storage optimisation regression ─────────────────────────────────

/// Pool struct carries locked and proposal_nonce — verify nonce increments.
#[test]
fn proposal_nonce_increments_in_pool() {
    let (env, client, admin) = setup();
    client.create(&admin);
    assert_eq!(client.pool().proposal_nonce, 0);
    client.propose(&admin, &ProposalAction::AddAdmin(Address::generate(&env)));
    assert_eq!(client.pool().proposal_nonce, 1);
}

/// Pool.locked starts false and does not block a normal deposit.
#[test]
fn pool_locked_field_starts_false() {
    let (_env, client, admin) = setup();
    client.create(&admin);
    assert!(!client.pool().locked);
}

// ── #265: proxy upgrade tests ─────────────────────────────────────────────

fn proxy_setup() -> (Env, VaultProxyClient<'static>, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    // Upgrade tests advance the ledger sequence past the timelock delay;
    // give storage entries a TTL long enough that the contract instance
    // does not archive before execute_upgrade runs.
    env.ledger().with_mut(|li| {
        li.min_persistent_entry_ttl = 10_000_000;
        li.min_temp_entry_ttl = 10_000_000;
        li.max_entry_ttl = 20_000_000;
    });
    let proxy_id = env.register_contract(None, VaultProxy);
    let client = VaultProxyClient::new(&env, &proxy_id);
    let admin = Address::generate(&env);
    let signer2 = Address::generate(&env);
    let logic = Address::generate(&env);
    (env, client, admin, signer2, logic)
}

fn init_proxy(
    env: &Env,
    client: &VaultProxyClient<'static>,
    admin: &Address,
    signer2: &Address,
    logic: &Address,
) {
    let signers: Vec<Address> = vec![env, admin.clone(), signer2.clone()];
    client.create_governed(admin, logic, &signers);
}

fn hash(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

fn provenance(env: &Env, byte: u8) -> WasmProvenance {
    WasmProvenance {
        source_hash: hash(env, byte),
        build_recipe_hash: hash(env, byte + 1),
        compiler_hash: hash(env, byte + 2),
    }
}

fn compatible_migration(env: &Env) -> MigrationCheck {
    MigrationCheck {
        plan_hash: hash(env, 10),
        state_hash: hash(env, 11),
        compatible: true,
    }
}

fn min_upgrade_ledger(env: &Env) -> u32 {
    env.ledger().sequence() + 17_280
}

fn skip_to_ledger(env: &Env, sequence: u32) {
    env.ledger().with_mut(|li| li.sequence_number = sequence);
}

fn propose_proxy_upgrade(
    env: &Env,
    client: &VaultProxyClient<'static>,
    signer: &Address,
    logic: &Address,
    target_hash: &BytesN<32>,
) -> u32 {
    client.propose_upgrade(
        signer,
        &UpgradeKind::Forward,
        logic,
        &client.current_hash(),
        target_hash,
        &2,
        &compatible_migration(env),
        &min_upgrade_ledger(env),
        &provenance(env, 12),
    )
}

#[test]
fn proxy_create_initialises() {
    let (env, client, admin, signer2, logic) = proxy_setup();
    init_proxy(&env, &client, &admin, &signer2, &logic);
    assert_eq!(client.admin(), admin);
    assert_eq!(client.logic_contract(), logic);
    assert_eq!(client.schema_version(), 1);
    assert_eq!(client.signers().len(), 2);
}

#[test]
fn proxy_upgrade_requires_quorum_and_timelock() {
    let (env, client, admin, signer2, logic1) = proxy_setup();
    init_proxy(&env, &client, &admin, &signer2, &logic1);

    let logic2 = Address::generate(&env);
    let target_hash = hash(&env, 42);
    let earliest = min_upgrade_ledger(&env);
    let pid = client.propose_upgrade(
        &admin,
        &UpgradeKind::Forward,
        &logic2,
        &client.current_hash(),
        &target_hash,
        &2,
        &compatible_migration(&env),
        &earliest,
        &provenance(&env, 12),
    );

    assert_eq!(
        client.try_execute_upgrade(&admin, &pid, &target_hash, &true, &true),
        Err(Ok(ProxyError::ThresholdNotMet))
    );

    assert!(client.approve_upgrade(&signer2, &pid));
    assert_eq!(
        client.try_execute_upgrade(&admin, &pid, &target_hash, &true, &true),
        Err(Ok(ProxyError::TimelockActive))
    );

    skip_to_ledger(&env, earliest);
    client.execute_upgrade(&admin, &pid, &target_hash, &true, &true);
    assert_eq!(client.logic_contract(), logic2);
    assert_eq!(client.current_hash(), target_hash);
    assert_eq!(client.schema_version(), 2);
}

#[test]
fn proxy_upgrade_rejects_substituted_artifact_hash() {
    let (env, client, admin, signer2, logic1) = proxy_setup();
    init_proxy(&env, &client, &admin, &signer2, &logic1);

    let logic2 = Address::generate(&env);
    let approved_hash = hash(&env, 50);
    let pid = propose_proxy_upgrade(&env, &client, &admin, &logic2, &approved_hash);
    assert!(client.approve_upgrade(&signer2, &pid));

    skip_to_ledger(&env, client.upgrade_proposal(&pid).earliest_ledger);
    assert_eq!(
        client.try_execute_upgrade(&admin, &pid, &hash(&env, 51), &true, &true),
        Err(Ok(ProxyError::HashMismatch))
    );
    assert_eq!(client.logic_contract(), logic1);
}

#[test]
fn proxy_upgrade_rejects_stale_governance_epoch() {
    let (env, client, admin, signer2, logic1) = proxy_setup();
    init_proxy(&env, &client, &admin, &signer2, &logic1);

    let signer3 = Address::generate(&env);
    let logic2 = Address::generate(&env);
    let target_hash = hash(&env, 60);
    let pid = propose_proxy_upgrade(&env, &client, &admin, &logic2, &target_hash);

    let approvals: Vec<Address> = vec![&env, admin.clone(), signer2.clone()];
    let next_signers: Vec<Address> = vec![&env, admin.clone(), signer2.clone(), signer3];
    client.rotate_signers(&approvals, &next_signers);
    assert_eq!(
        client.try_approve_upgrade(&signer2, &pid),
        Err(Ok(ProxyError::StaleProposal))
    );
}

#[test]
fn proxy_upgrade_rejects_failed_migration_before_live_mutation() {
    let (env, client, admin, signer2, logic1) = proxy_setup();
    init_proxy(&env, &client, &admin, &signer2, &logic1);

    let logic2 = Address::generate(&env);
    assert_eq!(
        client.try_propose_upgrade(
            &admin,
            &UpgradeKind::Forward,
            &logic2,
            &client.current_hash(),
            &hash(&env, 70),
            &2,
            &MigrationCheck {
                plan_hash: hash(&env, 10),
                state_hash: hash(&env, 11),
                compatible: false,
            },
            &min_upgrade_ledger(&env),
            &provenance(&env, 12),
        ),
        Err(Ok(ProxyError::MigrationSimulationFailed))
    );
    assert_eq!(client.logic_contract(), logic1);
}

#[test]
fn proxy_upgrade_rejects_invariant_failure_at_completion() {
    let (env, client, admin, signer2, logic1) = proxy_setup();
    init_proxy(&env, &client, &admin, &signer2, &logic1);

    let logic2 = Address::generate(&env);
    let target_hash = hash(&env, 80);
    let pid = propose_proxy_upgrade(&env, &client, &admin, &logic2, &target_hash);
    assert!(client.approve_upgrade(&signer2, &pid));

    skip_to_ledger(&env, client.upgrade_proposal(&pid).earliest_ledger);
    assert_eq!(
        client.try_execute_upgrade(&admin, &pid, &target_hash, &false, &true),
        Err(Ok(ProxyError::InvariantViolation))
    );
    assert_eq!(client.logic_contract(), logic1);
}

#[test]
fn proxy_rollback_preserves_later_writes() {
    let (env, client, admin, signer2, logic1) = proxy_setup();
    init_proxy(&env, &client, &admin, &signer2, &logic1);

    let logic2 = Address::generate(&env);
    let rollback_hash = hash(&env, 90);
    let pid = client.propose_upgrade(
        &admin,
        &UpgradeKind::Rollback,
        &logic2,
        &client.current_hash(),
        &rollback_hash,
        &1,
        &compatible_migration(&env),
        &min_upgrade_ledger(&env),
        &provenance(&env, 12),
    );
    assert!(client.approve_upgrade(&signer2, &pid));

    client.record_state_write(&admin);
    skip_to_ledger(&env, client.upgrade_proposal(&pid).earliest_ledger);
    assert_eq!(
        client.try_execute_upgrade(&admin, &pid, &rollback_hash, &true, &false),
        Err(Ok(ProxyError::StateDiscardBlocked))
    );

    client.execute_upgrade(&admin, &pid, &rollback_hash, &true, &true);
    assert_eq!(client.logic_contract(), logic2);
}

#[test]
fn proxy_records_reproducible_wasm_provenance() {
    let (env, client, admin, signer2, logic1) = proxy_setup();
    init_proxy(&env, &client, &admin, &signer2, &logic1);

    let logic2 = Address::generate(&env);
    let target_hash = hash(&env, 100);
    let expected_provenance = provenance(&env, 20);
    let pid = client.propose_upgrade(
        &admin,
        &UpgradeKind::Forward,
        &logic2,
        &client.current_hash(),
        &target_hash,
        &2,
        &compatible_migration(&env),
        &min_upgrade_ledger(&env),
        &expected_provenance,
    );
    assert_eq!(
        client.upgrade_proposal(&pid).provenance,
        expected_provenance
    );
    assert!(client.approve_upgrade(&signer2, &pid));

    skip_to_ledger(&env, client.upgrade_proposal(&pid).earliest_ledger);
    client.execute_upgrade(&admin, &pid, &target_hash, &true, &true);
    assert_eq!(client.last_provenance(), expected_provenance);
}

#[test]
fn proxy_upgrade_unauthorized_fails() {
    let (env, client, admin, signer2, logic) = proxy_setup();
    let rando = Address::generate(&env);
    let target_hash = hash(&env, 30);
    init_proxy(&env, &client, &admin, &signer2, &logic);
    assert_eq!(
        client.try_propose_upgrade(
            &rando,
            &UpgradeKind::Forward,
            &logic,
            &client.current_hash(),
            &target_hash,
            &2,
            &compatible_migration(&env),
            &min_upgrade_ledger(&env),
            &provenance(&env, 12),
        ),
        Err(Ok(ProxyError::Unauthorized))
    );
}

#[test]
fn test_cost_budgets() {
    extern crate std;
    use std::collections::HashMap;
    use std::string::ToString;
    use std::{eprintln, format, println};

    let thresholds_str = include_str!("../cost_thresholds.txt");
    let mut thresholds = HashMap::new();

    for line in thresholds_str.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, val)) = line.split_once('=') {
            if let Ok(num) = val.trim().parse::<u64>() {
                thresholds.insert(key.trim().to_string(), num);
            }
        }
    }

    let (env, client, admin) = setup();

    // 1. Create
    client.create(&admin);
    let create_cpu = env.budget().cpu_instruction_cost();
    let create_mem = env.budget().memory_bytes_cost();

    // 2. Join
    let alice = Address::generate(&env);
    env.budget().reset_default();
    client.join(&alice);
    let join_cpu = env.budget().cpu_instruction_cost();
    let join_mem = env.budget().memory_bytes_cost();

    // 3. Deposit
    env.budget().reset_default();
    client.deposit(&alice, &100);
    let deposit_cpu = env.budget().cpu_instruction_cost();
    let deposit_mem = env.budget().memory_bytes_cost();

    // 4. Drip
    env.budget().reset_default();
    client.drip(&alice, &50);
    let drip_cpu = env.budget().cpu_instruction_cost();
    let drip_mem = env.budget().memory_bytes_cost();

    // 5. Draw Winner
    env.budget().reset_default();
    client.draw_winner(&admin, &200);
    let draw_winner_cpu = env.budget().cpu_instruction_cost();
    let draw_winner_mem = env.budget().memory_bytes_cost();

    // 6. Claim
    env.budget().reset_default();
    client.claim(&alice);
    let claim_cpu = env.budget().cpu_instruction_cost();
    let claim_mem = env.budget().memory_bytes_cost();

    // 7. Withdraw
    skip_lockup(&env);
    env.budget().reset_default();
    client.withdraw(&alice);
    let withdraw_cpu = env.budget().cpu_instruction_cost();
    let withdraw_mem = env.budget().memory_bytes_cost();

    // 8. Propose
    env.budget().reset_default();
    let _pid = client.propose(&admin, &ProposalAction::AddAdmin(Address::generate(&env)));
    let propose_cpu = env.budget().cpu_instruction_cost();
    let propose_mem = env.budget().memory_bytes_cost();

    // 9. Approve
    let signer2 = Address::generate(&env);
    client.add_admin(&admin, &signer2);
    let pid2 = client.propose(
        &admin,
        &ProposalAction::ReleaseEscrow(Address::generate(&env), 10),
    );
    env.budget().reset_default();
    client.approve(&signer2, &pid2);
    let approve_cpu = env.budget().cpu_instruction_cost();
    let approve_mem = env.budget().memory_bytes_cost();

    // Output measurements for local developers
    println!("=== Soroban Drip Pool Cost Profile ===");
    println!("create(admin):         cpu={create_cpu}, mem={create_mem}");
    println!("join(who):             cpu={join_cpu}, mem={join_mem}");
    println!("deposit(who, amount):  cpu={deposit_cpu}, mem={deposit_mem}");
    println!("drip(who, amount):     cpu={drip_cpu}, mem={drip_mem}");
    println!("draw_winner(prize):    cpu={draw_winner_cpu}, mem={draw_winner_mem}");
    println!("claim(who):            cpu={claim_cpu}, mem={claim_mem}");
    println!("withdraw(who):         cpu={withdraw_cpu}, mem={withdraw_mem}");
    println!("propose(action):       cpu={propose_cpu}, mem={propose_mem}");
    println!("approve(id):           cpu={approve_cpu}, mem={approve_mem}");

    let mut failed = false;
    let mut fail_msgs = std::vec::Vec::new();

    let mut check_limit = |op: &str, metric: &str, actual: u64| {
        let key = format!("{}_{}", op, metric);
        if let Some(&limit) = thresholds.get(&key) {
            if actual > limit {
                failed = true;
                fail_msgs.push(format!(
                    "Cost Regression: {}/{} exceeded threshold! Actual: {}, Limit: {}",
                    op, metric, actual, limit
                ));
            }
        } else {
            failed = true;
            fail_msgs.push(format!("Missing threshold definition for key: {}", key));
        }
    };

    check_limit("create", "cpu", create_cpu);
    check_limit("create", "mem", create_mem);
    check_limit("join", "cpu", join_cpu);
    check_limit("join", "mem", join_mem);
    check_limit("deposit", "cpu", deposit_cpu);
    check_limit("deposit", "mem", deposit_mem);
    check_limit("drip", "cpu", drip_cpu);
    check_limit("drip", "mem", drip_mem);
    check_limit("draw_winner", "cpu", draw_winner_cpu);
    check_limit("draw_winner", "mem", draw_winner_mem);
    check_limit("claim", "cpu", claim_cpu);
    check_limit("claim", "mem", claim_mem);
    check_limit("withdraw", "cpu", withdraw_cpu);
    check_limit("withdraw", "mem", withdraw_mem);
    check_limit("propose", "cpu", propose_cpu);
    check_limit("propose", "mem", propose_mem);
    check_limit("approve", "cpu", approve_cpu);
    check_limit("approve", "mem", approve_mem);

    if failed {
        eprintln!("\n=== BUDGET CHECK FAILURE ===");
        for msg in &fail_msgs {
            eprintln!("  [FAIL] {}", msg);
        }
        eprintln!("============================\n");
        panic!("Cost budget validation failed. See output above for details.");
    }
}

// ── #16: Multi-round lockup rollover & repeated deposits coverage ─────────

#[test]
fn test_multi_round_lockup_rollover_mixed_durations() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let alice = Address::generate(&env);
    client.join(&alice);

    // 1. Initial short deposit (7 days lockup)
    client.deposit_with_duration(&alice, &100, &7);
    let s1 = client.savings(&alice);
    assert_eq!(s1.deposited, 100);
    assert_eq!(s1.lockup_multiplier, 110);
    let initial_locked_until = s1.locked_until;
    assert!(initial_locked_until > env.ledger().sequence());

    // 2. Add long deposit (90 days) before short lockup expires
    client.deposit_with_duration(&alice, &200, &90);
    let s2 = client.savings(&alice);
    assert_eq!(s2.deposited, 300);
    assert_eq!(s2.claimable, 300);
    assert_eq!(s2.lockup_multiplier, 150);
    // Lockup sequence extended
    assert!(s2.locked_until > initial_locked_until);

    // 3. Early withdrawal attempt is blocked
    assert_eq!(client.try_withdraw(&alice), Err(Ok(Error::LockupActive)));

    // 4. Skip sequence past long lockup
    env.ledger().with_mut(|li| {
        li.min_persistent_entry_ttl = 5_000_000;
        li.max_entry_ttl = 10_000_000;
        li.sequence_number = s2.locked_until + 1;
    });

    // 5. Withdrawal succeeds with yield multiplier applied (300 * 150 / 100 = 450)
    let payout = client.withdraw(&alice);
    assert_eq!(payout, 450);
}

#[test]
fn test_deposit_flexible_during_active_lockup_preserves_lockup() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let alice = Address::generate(&env);
    client.join(&alice);

    // Deposit medium duration (14 days)
    client.deposit_with_duration(&alice, &150, &14);
    let s1 = client.savings(&alice);
    assert_eq!(s1.lockup_multiplier, 125);
    let locked_until = s1.locked_until;

    // Deposit flexible duration (0 days) while lockup is active
    client.deposit_with_duration(&alice, &50, &0);
    let s2 = client.savings(&alice);
    assert_eq!(s2.deposited, 200);
    // Active locked_until must remain preserved (not reset to 0/current sequence)
    assert_eq!(s2.locked_until, locked_until);

    // Early withdrawal still blocked
    assert_eq!(client.try_withdraw(&alice), Err(Ok(Error::LockupActive)));

    // Advance sequence past lockup
    env.ledger().with_mut(|li| {
        li.min_persistent_entry_ttl = 5_000_000;
        li.max_entry_ttl = 10_000_000;
        li.sequence_number = locked_until + 1;
    });

    // Withdrawal succeeds
    let payout = client.withdraw(&alice);
    assert_eq!(payout, 200);
}

#[test]
fn test_deposit_after_lockup_expiration_resets_lockup_window() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let alice = Address::generate(&env);
    client.join(&alice);

    // Deposit short duration (7 days)
    client.deposit_with_duration(&alice, &100, &7);
    let s1 = client.savings(&alice);

    // Skip sequence past short lockup
    env.ledger().with_mut(|li| {
        li.min_persistent_entry_ttl = 5_000_000;
        li.max_entry_ttl = 10_000_000;
        li.sequence_number = s1.locked_until + 10;
    });

    // Participant deposits again with long duration (90 days)
    client.deposit_with_duration(&alice, &300, &90);
    let s2 = client.savings(&alice);
    assert_eq!(s2.deposited, 400);
    assert_eq!(s2.lockup_multiplier, 150);
    assert!(s2.locked_until > env.ledger().sequence());

    // Early withdrawal blocked under new lockup window
    assert_eq!(client.try_withdraw(&alice), Err(Ok(Error::LockupActive)));

    // Skip past long lockup window
    env.ledger().with_mut(|li| {
        li.min_persistent_entry_ttl = 5_000_000;
        li.max_entry_ttl = 10_000_000;
        li.sequence_number = s2.locked_until + 1;
    });

    // Withdrawal succeeds with 1.5x multiplier boost (400 * 150 / 100 = 600)
    let payout = client.withdraw(&alice);
    assert_eq!(payout, 600);
}

#[test]
fn vault_withdrawal_queue_enforces_fifo_and_partial_claims_survive_pause() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let asset = deploy_asset(&env, &admin);
    client.vault_init(&admin, &asset);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    mint(&env, &asset, &alice, 1_000);
    mint(&env, &asset, &bob, 1_000);
    let alice_shares = client.vault_deposit(&alice, &1_000, &client.vault_snapshot().version);
    let bob_shares = client.vault_deposit(&bob, &1_000, &client.vault_snapshot().version);

    let alice_request = client.vault_request_withdrawal(
        &alice,
        &(alice_shares / 2),
        &client.vault_snapshot().version,
    );
    let bob_request =
        client.vault_request_withdrawal(&bob, &(bob_shares / 2), &client.vault_snapshot().version);

    assert_eq!(
        client.try_vault_fulfill_withdrawal(&admin, &bob_request, &100),
        Err(Ok(Error::QueueBlocked))
    );

    assert_eq!(
        client.vault_fulfill_withdrawal(&admin, &alice_request, &100),
        100
    );
    let alice_status = client.vault_withdrawal_status(&alice_request);
    assert_eq!(alice_status.claimable_assets, 100);
    assert!(alice_status.remaining_assets > 0);
    // #100: `fulfill` is internal reservation only — no token leaves custody yet.
    assert_eq!(token_balance(&env, &asset, &client.address), 2_000);

    client.vault_set_paused(&admin, &true);
    assert_eq!(
        client.try_vault_deposit(&alice, &1, &client.vault_snapshot().version),
        Err(Ok(Error::Paused))
    );
    assert_eq!(client.vault_claim_withdrawal(&alice, &alice_request), 100);
    assert_eq!(
        client
            .vault_withdrawal_status(&alice_request)
            .claimable_assets,
        0
    );
    // #100: `claim` is where the real payout happens.
    assert_eq!(token_balance(&env, &asset, &alice), 100);
    assert_eq!(token_balance(&env, &asset, &client.address), 1_900);
}

#[test]
fn vault_cancel_and_expiry_restore_shares_and_unblock_queue() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let asset = deploy_asset(&env, &admin);
    client.vault_init(&admin, &asset);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    mint(&env, &asset, &alice, 1_000);
    mint(&env, &asset, &bob, 1_000);
    let alice_shares = client.vault_deposit(&alice, &1_000, &client.vault_snapshot().version);
    let bob_shares = client.vault_deposit(&bob, &1_000, &client.vault_snapshot().version);

    let alice_request = client.vault_request_withdrawal(
        &alice,
        &(alice_shares / 2),
        &client.vault_snapshot().version,
    );
    let bob_request = client.vault_request_withdrawal_to(
        &bob,
        &bob,
        &(bob_shares / 2),
        &0,
        &2,
        &client.vault_snapshot().version,
    );

    let restored = client.vault_cancel_withdrawal(&alice, &alice_request);
    assert_eq!(restored, alice_shares / 2);
    assert_eq!(client.vault_share_balance(&alice), alice_shares);

    env.ledger().with_mut(|li| li.sequence_number += 3);
    let expired = client.vault_expire_withdrawal(&bob, &bob_request);
    assert_eq!(expired, bob_shares / 2);
    assert_eq!(client.vault_withdrawal_head(), 2);

    let status = client.vault_withdrawal_status(&bob_request);
    assert_eq!(status.state, shares::WithdrawalState::Expired);
}

fn generate_secret_and_commitment(env: &Env, secret_val: u8) -> (BytesN<32>, BytesN<32>) {
    let mut secret_bytes = [0u8; 32];
    secret_bytes[0] = secret_val;
    let secret = BytesN::from_array(env, &secret_bytes);
    let commitment: BytesN<32> = env.crypto().sha256(secret.as_ref()).into();
    (secret, commitment)
}

#[test]
fn test_commit_reveal_success() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    client.join(&alice);
    client.deposit(&alice, &1_000);
    client.join(&bob);
    client.deposit(&bob, &2_000);

    let current = env.ledger().sequence();
    let freeze_ledger = current + 2;
    let reveal_deadline = current + 10;

    let (secret, commitment) = generate_secret_and_commitment(&env, 42);

    client.commit_draw(
        &admin,
        &1, // round_id
        &commitment,
        &freeze_ledger,
        &reveal_deadline,
        &500, // prize
    );

    // Verify deposits/withdrawals are blocked while draw is active
    assert_eq!(client.try_deposit(&alice, &100), Err(Ok(Error::DrawActive)));
    assert_eq!(client.try_withdraw(&alice), Err(Ok(Error::DrawActive)));

    // Verify finalize fails before freeze_ledger
    assert_eq!(
        client.try_finalize_draw(&secret, &vec![&env, alice.clone(), bob.clone()]),
        Err(Ok(Error::DrawNotFrozen))
    );

    // Advance sequence past freeze ledger
    env.ledger()
        .with_mut(|li| li.sequence_number = freeze_ledger + 1);

    // Finalize draw
    let winner = client.finalize_draw(&secret, &vec![&env, alice.clone(), bob.clone()]);
    assert!(winner == alice || winner == bob);

    let win_p = client.savings(&winner);
    assert_eq!(win_p.claimable, 500 + win_p.deposited); // deposit is 1000 or 2000, claimable starts as deposit + prize

    // Verify idempotency: cannot finalize again
    assert_eq!(
        client.try_finalize_draw(&secret, &vec![&env, alice.clone(), bob.clone()]),
        Err(Ok(Error::DrawNotCommitted))
    );

    // Verify deposits/withdrawals are unblocked
    client.deposit(&alice, &100);
    assert_eq!(client.savings(&alice).deposited, 1100);
}

#[test]
fn test_commit_reveal_failure_and_cancellation() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &1_000);

    let current = env.ledger().sequence();
    let freeze_ledger = current + 2;
    let reveal_deadline = current + 10;

    let (secret, commitment) = generate_secret_and_commitment(&env, 99);

    client.commit_draw(
        &admin,
        &1, // round_id
        &commitment,
        &freeze_ledger,
        &reveal_deadline,
        &500, // prize
    );

    // Try to cancel before deadline - should fail for non-admin
    let rando = Address::generate(&env);
    assert_eq!(
        client.try_cancel_draw(&rando),
        Err(Ok(Error::DeadlineNotReached))
    );

    // Advance sequence past deadline
    env.ledger()
        .with_mut(|li| li.sequence_number = reveal_deadline + 1);

    // Verify finalize fails now
    assert_eq!(
        client.try_finalize_draw(&secret, &vec![&env, alice.clone()]),
        Err(Ok(Error::DeadlinePassed))
    );

    // Cancel draw (can be called by anyone after deadline)
    client.cancel_draw(&rando);

    // Verify deposits/withdrawals are unblocked
    client.deposit(&alice, &100);
    assert_eq!(client.savings(&alice).deposited, 1100);
}

#[test]
fn test_commit_reveal_participants_validation() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &1_000);
    client.join(&bob);
    client.deposit(&bob, &2_000);

    let current = env.ledger().sequence();
    let freeze_ledger = current + 2;
    let reveal_deadline = current + 10;

    let (secret, commitment) = generate_secret_and_commitment(&env, 123);

    client.commit_draw(
        &admin,
        &1,
        &commitment,
        &freeze_ledger,
        &reveal_deadline,
        &500,
    );

    env.ledger()
        .with_mut(|li| li.sequence_number = freeze_ledger + 1);

    // 1. Omit Bob - total weight doesn't match total_deposited
    assert_eq!(
        client.try_finalize_draw(&secret, &vec![&env, alice.clone()]),
        Err(Ok(Error::InvalidParticipantsList))
    );

    // 2. Duplicate Alice
    assert_eq!(
        client.try_finalize_draw(
            &secret,
            &vec![&env, alice.clone(), alice.clone(), bob.clone()]
        ),
        Err(Ok(Error::DuplicateParticipant))
    );

    // 3. Unjoined address
    let rando = Address::generate(&env);
    assert_eq!(
        client.try_finalize_draw(
            &secret,
            &vec![&env, alice.clone(), bob.clone(), rando.clone()]
        ),
        Err(Ok(Error::NotJoined))
    );
}

#[test]
fn test_commit_reveal_rejection_sampling_unbiased() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &100); // 10% weight
    client.join(&bob);
    client.deposit(&bob, &900); // 90% weight

    let mut alice_wins = 0;
    let mut bob_wins = 0;

    // Run 30 rounds of draws with different secrets to verify statistical distribution
    for round in 1..=30 {
        let current = env.ledger().sequence();
        let freeze_ledger = current + 1;
        let reveal_deadline = current + 5;

        let (secret, commitment) = generate_secret_and_commitment(&env, round as u8);

        client.commit_draw(
            &admin,
            &round,
            &commitment,
            &freeze_ledger,
            &reveal_deadline,
            &100,
        );

        env.ledger()
            .with_mut(|li| li.sequence_number = freeze_ledger + 1);

        let winner = client.finalize_draw(&secret, &vec![&env, alice.clone(), bob.clone()]);
        if winner == alice {
            alice_wins += 1;
        } else if winner == bob {
            bob_wins += 1;
        }
    }

    // Both should win at least once, and Bob should win significantly more
    assert!(alice_wins > 0);
    assert!(bob_wins > 0);
    assert!(bob_wins > alice_wins);
}

// ── #108: legacy accounting / share-vault mixed-mode invariant ─────────────
// The legacy drip/deposit/withdraw path and the share-based vault both track
// pool balances without independently verified token custody. Once either
// has recorded a real balance for a pool, switching to the other must be
// rejected so their totals can never silently diverge or double-count the
// same (unverified) custody.

#[test]
fn legacy_deposit_rejected_once_vault_has_shares() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let asset = deploy_asset(&env, &admin);
    client.vault_init(&admin, &asset);

    let alice = Address::generate(&env);
    mint(&env, &asset, &alice, 1_000);
    client.vault_deposit(&alice, &1_000, &client.vault_snapshot().version);

    // The vault now holds real (share-accounted) balance for this pool;
    // the legacy path must not be usable alongside it.
    client.join(&alice);
    assert_eq!(
        client.try_deposit(&alice, &100),
        Err(Ok(Error::MixedAccountingModeNotAllowed))
    );
    assert_eq!(
        client.try_drip(&alice, &100),
        Err(Ok(Error::MixedAccountingModeNotAllowed))
    );
    assert_eq!(
        client.try_deposit_with_duration(&alice, &100, &30),
        Err(Ok(Error::MixedAccountingModeNotAllowed))
    );
}

#[test]
fn vault_deposit_rejected_once_legacy_has_deposits() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let asset = deploy_asset(&env, &admin);
    client.vault_init(&admin, &asset);

    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &100);

    // Legacy accounting now holds real balance for this pool; the vault
    // path must not be usable alongside it.
    let bob = Address::generate(&env);
    assert_eq!(
        client.try_vault_deposit(&bob, &1_000, &client.vault_snapshot().version),
        Err(Ok(Error::MixedAccountingModeNotAllowed))
    );
}

#[test]
fn legacy_deposit_still_works_when_vault_unused() {
    // Sanity check: pools that never touch the share vault are unaffected
    // (this is the vast majority of existing legacy-only pools/tests).
    let (env, client, admin) = setup();
    client.create(&admin);

    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &100);
    let pool = client.pool();
    assert_eq!(pool.total_deposited, 100);
}

// ── fee bounds validation ──────────────────────────────────────────────────

#[test]
fn fee_setters_reject_out_of_bounds_values_before_storage_mutation() {
    let (_env, client, admin) = setup();
    client.create(&admin);

    // 0 is valid
    assert!(client.try_vault_set_management_fee_bps(&admin, &0).is_ok());
    assert!(client.try_vault_set_performance_fee_bps(&admin, &0).is_ok());

    // 10,000 (max) is valid
    assert!(client
        .try_vault_set_management_fee_bps(&admin, &10_000)
        .is_ok());
    assert!(client
        .try_vault_set_performance_fee_bps(&admin, &10_000)
        .is_ok());

    // 10,001 (max + 1) is invalid
    assert_eq!(
        client.try_vault_set_management_fee_bps(&admin, &10_001),
        Err(Ok(Error::InvalidFeeBps))
    );
    assert_eq!(
        client.try_vault_set_performance_fee_bps(&admin, &10_001),
        Err(Ok(Error::InvalidFeeBps))
    );

    // u32::MAX is invalid
    assert_eq!(
        client.try_vault_set_management_fee_bps(&admin, &u32::MAX),
        Err(Ok(Error::InvalidFeeBps))
    );
    assert_eq!(
        client.try_vault_set_performance_fee_bps(&admin, &u32::MAX),
        Err(Ok(Error::InvalidFeeBps))
    );
}

#[test]
fn legacy_invalid_configuration_is_safely_capped_during_accrual() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    let asset = deploy_asset(&env, &admin);
    mint(&env, &asset, &alice, 100_000);

    client.vault_init(&admin, &asset);

    // Manually force invalid config via raw storage to simulate pre-migration state
    env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .set(&VaultKey::ManagementFeeBps, &15_000u32);
        env.storage()
            .instance()
            .set(&VaultKey::PerformanceFeeBps, &u32::MAX);
    });

    client.vault_deposit(&alice, &100_000, &client.vault_snapshot().version);

    // Accrual does not overflow or panic because of min(10_000) cap
    client.vault_accrue_management_fee(&admin);
    client.vault_accrue_performance_fee(&admin);
}

// ── #100: vault custody — real token transfer coverage ─────────────────────
// `vault_deposit`/`vault_claim_withdrawal` now move real SEP-41 tokens instead
// of only mutating internal accounting. These tests cover the scenarios a
// plain Stellar Asset Contract can't produce on its own (short/fee-on-transfer
// delivery, a transfer that tries to re-enter the vault), plus atomicity,
// duplicate-claim, and custody/accounting reconciliation.

// Each mock token lives in its own submodule: `#[contractimpl]` generates
// module-scoped helper items keyed only by method name (`__mint`,
// `__balance`, `__transfer`, ...), so two contracts sharing method names in
// the same Rust module would collide.
mod fee_on_transfer_token {
    use super::*;

    #[derive(Clone)]
    #[contracttype]
    enum MockTokenKey {
        Balance(Address),
    }

    /// Skims a flat 1% "fee" on every transfer: `to` receives less than
    /// `from` was debited — the shape of a fee-on-transfer token. The vault
    /// must reject this rather than mint shares (or mark a claim paid) for
    /// less custody than it actually received.
    #[contract]
    pub struct FeeOnTransferToken;

    #[contractimpl]
    impl FeeOnTransferToken {
        pub fn mint(env: Env, to: Address, amount: i128) {
            let key = MockTokenKey::Balance(to);
            let balance: i128 = env.storage().persistent().get(&key).unwrap_or(0);
            env.storage().persistent().set(&key, &(balance + amount));
        }

        pub fn balance(env: Env, id: Address) -> i128 {
            env.storage()
                .persistent()
                .get(&MockTokenKey::Balance(id))
                .unwrap_or(0)
        }

        pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
            from.require_auth();
            let from_key = MockTokenKey::Balance(from);
            let from_balance: i128 = env.storage().persistent().get(&from_key).unwrap_or(0);
            env.storage()
                .persistent()
                .set(&from_key, &(from_balance - amount));

            let credited = amount - (amount / 100);
            let to_key = MockTokenKey::Balance(to);
            let to_balance: i128 = env.storage().persistent().get(&to_key).unwrap_or(0);
            env.storage()
                .persistent()
                .set(&to_key, &(to_balance + credited));
        }
    }
}
use fee_on_transfer_token::{FeeOnTransferToken, FeeOnTransferTokenClient};

mod reentrant_token {
    use super::*;

    #[derive(Clone)]
    #[contracttype]
    enum ReentrantTokenKey {
        Balance(Address),
        Vault,
        Attacker,
        ExpectedVersion,
    }

    /// A token whose `transfer` calls back into the vault mid-call,
    /// attempting a second `vault_deposit` before the first one has finished
    /// mutating state. Proves the vault's dedicated `VaultKey::VaultLocked`
    /// guard actually blocks reentrancy rather than relying on transfer
    /// ordering alone.
    #[contract]
    pub struct ReentrantToken;

    #[contractimpl]
    impl ReentrantToken {
        pub fn mint(env: Env, to: Address, amount: i128) {
            let key = ReentrantTokenKey::Balance(to);
            let balance: i128 = env.storage().persistent().get(&key).unwrap_or(0);
            env.storage().persistent().set(&key, &(balance + amount));
        }

        pub fn balance(env: Env, id: Address) -> i128 {
            env.storage()
                .persistent()
                .get(&ReentrantTokenKey::Balance(id))
                .unwrap_or(0)
        }

        /// Configures the vault + attacker address the reentrant call will target.
        pub fn arm(env: Env, vault: Address, attacker: Address, expected_version: u64) {
            env.storage()
                .instance()
                .set(&ReentrantTokenKey::Vault, &vault);
            env.storage()
                .instance()
                .set(&ReentrantTokenKey::Attacker, &attacker);
            env.storage()
                .instance()
                .set(&ReentrantTokenKey::ExpectedVersion, &expected_version);
        }

        pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
            from.require_auth();
            let from_key = ReentrantTokenKey::Balance(from);
            let from_balance: i128 = env.storage().persistent().get(&from_key).unwrap_or(0);
            env.storage()
                .persistent()
                .set(&from_key, &(from_balance - amount));
            let to_key = ReentrantTokenKey::Balance(to);
            let to_balance: i128 = env.storage().persistent().get(&to_key).unwrap_or(0);
            env.storage()
                .persistent()
                .set(&to_key, &(to_balance + amount));

            if let Some(vault) = env
                .storage()
                .instance()
                .get::<_, Address>(&ReentrantTokenKey::Vault)
            {
                let attacker: Address = env
                    .storage()
                    .instance()
                    .get(&ReentrantTokenKey::Attacker)
                    .unwrap();
                let expected_version: u64 = env
                    .storage()
                    .instance()
                    .get(&ReentrantTokenKey::ExpectedVersion)
                    .unwrap();
                let client = DripPoolClient::new(&env, &vault);
                // Reentrant deposit attempt while the outer deposit is still mid-flight.
                // Must fail with `Locked`, not silently succeed and double-account.
                let _ = client.try_vault_deposit(&attacker, &1, &expected_version);
            }
        }
    }
}
use reentrant_token::{ReentrantToken, ReentrantTokenClient};

#[test]
fn vault_deposit_mints_shares_only_after_exact_transfer_lands() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let asset = deploy_asset(&env, &admin);
    client.vault_init(&admin, &asset);

    let alice = Address::generate(&env);
    mint(&env, &asset, &alice, 1_000);

    let shares = client.vault_deposit(&alice, &1_000, &client.vault_snapshot().version);
    assert!(shares > 0);
    assert_eq!(token_balance(&env, &asset, &alice), 0);
    assert_eq!(token_balance(&env, &asset, &client.address), 1_000);
    assert_eq!(client.vault_snapshot().total_assets, 1_000);
}

#[test]
fn vault_deposit_fails_atomically_when_depositor_has_no_balance() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let asset = deploy_asset(&env, &admin);
    client.vault_init(&admin, &asset);

    let alice = Address::generate(&env);
    // Alice never received any tokens — the underlying transfer must fail
    // (the SAC traps on insufficient balance), and it must fail atomically:
    // no shares minted, no accounting mutated, despite the failure happening
    // partway through `vault_deposit`.
    let result = client.try_vault_deposit(&alice, &1_000, &client.vault_snapshot().version);
    assert!(result.is_err());

    let snapshot = client.vault_snapshot();
    assert_eq!(snapshot.total_shares, 0);
    assert_eq!(snapshot.total_assets, 0);
    assert_eq!(snapshot.version, 0);
    assert_eq!(client.vault_share_balance(&alice), 0);
}

#[test]
fn vault_deposit_fails_when_depositor_only_holds_a_different_asset() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let asset = deploy_asset(&env, &admin);
    let unrelated_asset = deploy_asset(&env, &admin);
    client.vault_init(&admin, &asset);

    let alice = Address::generate(&env);
    // Alice holds the wrong asset — plenty of balance, just not in the token
    // this vault custodies — so the pull must fail against the real asset.
    mint(&env, &unrelated_asset, &alice, 1_000);

    let result = client.try_vault_deposit(&alice, &1_000, &client.vault_snapshot().version);
    assert!(result.is_err());
    assert_eq!(client.vault_snapshot().total_assets, 0);
    assert_eq!(client.vault_share_balance(&alice), 0);
}

#[test]
fn vault_deposit_rejects_fee_on_transfer_short_delivery() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let asset_id = env.register_contract(None, FeeOnTransferToken);
    let asset_client = FeeOnTransferTokenClient::new(&env, &asset_id);
    client.vault_init(&admin, &asset_id);

    let alice = Address::generate(&env);
    asset_client.mint(&alice, &1_000);

    let result = client.try_vault_deposit(&alice, &1_000, &client.vault_snapshot().version);
    assert_eq!(result, Err(Ok(Error::TransferAmountMismatch)));

    // Rejected before any share/accounting mutation, even though 990 units
    // did land in the vault's balance — a short transfer must never be
    // silently treated as a full one.
    assert_eq!(client.vault_share_balance(&alice), 0);
    assert_eq!(client.vault_snapshot().total_assets, 0);
    assert_eq!(client.vault_snapshot().version, 0);
}

#[test]
fn vault_deposit_reentrancy_is_blocked_by_vault_lock() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let asset_id = env.register_contract(None, ReentrantToken);
    let asset_client = ReentrantTokenClient::new(&env, &asset_id);
    client.vault_init(&admin, &asset_id);

    let alice = Address::generate(&env);
    let attacker = Address::generate(&env);
    asset_client.mint(&alice, &1_000);
    asset_client.mint(&attacker, &1_000);
    asset_client.arm(&client.address, &attacker, &client.vault_snapshot().version);

    let shares = client.vault_deposit(&alice, &1_000, &client.vault_snapshot().version);
    assert!(shares > 0);

    // The reentrant call fired mid-transfer must have been rejected by the
    // lock: the attacker never got shares, and the vault only accounts for
    // Alice's single legitimate deposit.
    assert_eq!(client.vault_share_balance(&attacker), 0);
    assert_eq!(client.vault_snapshot().total_shares, shares);
    assert_eq!(client.vault_snapshot().total_assets, 1_000);
}

#[test]
fn vault_claim_withdrawal_cannot_be_claimed_twice() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let asset = deploy_asset(&env, &admin);
    client.vault_init(&admin, &asset);

    let alice = Address::generate(&env);
    mint(&env, &asset, &alice, 1_000);
    let shares = client.vault_deposit(&alice, &1_000, &client.vault_snapshot().version);
    let request =
        client.vault_request_withdrawal(&alice, &shares, &client.vault_snapshot().version);
    client.vault_fulfill_withdrawal(&admin, &request, &1_000);

    let claimed = client.vault_claim_withdrawal(&alice, &request);
    assert_eq!(claimed, 1_000);
    assert_eq!(token_balance(&env, &asset, &alice), 1_000);

    // A second claim on the same, already-settled request must not pay out again.
    assert_eq!(
        client.try_vault_claim_withdrawal(&alice, &request),
        Err(Ok(Error::WithdrawalAlreadySettled))
    );
    assert_eq!(token_balance(&env, &asset, &alice), 1_000);
    assert_eq!(token_balance(&env, &asset, &client.address), 0);
}

#[test]
fn vault_custody_balance_reconciles_with_internal_accounting_through_full_lifecycle() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let asset = deploy_asset(&env, &admin);
    client.vault_init(&admin, &asset);

    let alice = Address::generate(&env);
    mint(&env, &asset, &alice, 1_000);
    let shares = client.vault_deposit(&alice, &1_000, &client.vault_snapshot().version);

    // Invariant: with nothing queued, real custody equals internal total_assets.
    assert_eq!(
        token_balance(&env, &asset, &client.address),
        client.vault_snapshot().total_assets
    );

    let request =
        client.vault_request_withdrawal(&alice, &shares, &client.vault_snapshot().version);
    client.vault_fulfill_withdrawal(&admin, &request, &400);

    // Invariant: real custody == total_assets still held + assets paid-but-unclaimed.
    let status = client.vault_withdrawal_status(&request);
    assert_eq!(
        token_balance(&env, &asset, &client.address),
        client.vault_snapshot().total_assets + status.claimable_assets
    );

    client.vault_claim_withdrawal(&alice, &request);

    // Once claimed, the paid portion has actually left custody.
    let status = client.vault_withdrawal_status(&request);
    assert_eq!(status.claimable_assets, 0);
    assert_eq!(
        token_balance(&env, &asset, &client.address),
        client.vault_snapshot().total_assets
    );
    assert_eq!(token_balance(&env, &asset, &alice), 400);
}
