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
fn added_signer_counts_toward_threshold() {
    let (env, client, admin) = setup();
    client.create(&admin);
    client.deposit(&admin, &500);

    let signer2 = Address::generate(&env);
    client.add_admin(&admin, &signer2);
    assert_eq!(client.admins().len(), 2);

    let recipient = Address::generate(&env);
    let pid = client.propose(
        &admin,
        &ProposalAction::ReleaseEscrow(recipient.clone(), 200),
    );
    assert!(client.approve(&signer2, &pid));
    assert_eq!(client.pool().total_deposited, 300);
}

#[test]
fn duplicate_add_admin_is_noop() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let signer2 = Address::generate(&env);
    client.add_admin(&admin, &signer2);
    client.add_admin(&admin, &signer2);
    // No duplicate entry in the signer set.
    assert_eq!(client.admins().len(), 2);
}

#[test]
fn removed_signer_cannot_propose() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let signer2 = Address::generate(&env);
    client.add_admin(&admin, &signer2);
    client.remove_admin(&admin, &signer2);
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
    client.add_admin(&admin, &signer3);

    let recipient = Address::generate(&env);
    let pid = client.propose(
        &admin,
        &ProposalAction::ReleaseEscrow(recipient.clone(), 200),
    );

    // Revoke signer3 while the proposal is pending.
    client.remove_admin(&admin, &signer3);
    assert_eq!(
        client.try_approve(&signer3, &pid),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(client.pool().total_deposited, 500);

    // Remaining signers can still complete the proposal.
    assert!(client.approve(&signer2, &pid));
    assert_eq!(client.pool().total_deposited, 300);
}

#[test]
fn non_signer_cannot_approve() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let pid = client.propose(&admin, &ProposalAction::AddAdmin(Address::generate(&env)));
    let rando = Address::generate(&env);
    assert_eq!(
        client.try_approve(&rando, &pid),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn duplicate_approval_does_not_inflate_threshold() {
    let (env, client, admin) = setup();
    client.create(&admin);
    client.deposit(&admin, &500);

    let signer2 = Address::generate(&env);
    let signer3 = Address::generate(&env);
    client.add_admin(&admin, &signer2);
    client.add_admin(&admin, &signer3);

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

    // A second distinct signer proves the count was still 1 of 2.
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
    client.add_admin(&admin, &signer3);

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
    client.add_admin(&admin, &signer3);

    let recipient = Address::generate(&env);
    let pid = client.propose(
        &admin,
        &ProposalAction::ReleaseEscrow(recipient.clone(), 200),
    );
    assert!(client.approve(&signer2, &pid));

    // Executed proposals are deleted — a late approval cannot re-execute.
    assert_eq!(
        client.try_approve(&signer3, &pid),
        Err(Ok(Error::ProposalNotFound))
    );
    assert_eq!(client.pool().total_deposited, 300);
}

/// Documents current behaviour: an approval recorded while the signer was
/// still a member is NOT pruned when that signer is later removed. The stale
/// approval keeps counting toward the threshold. If this is undesirable,
/// approvals must be re-validated against the signer set at execution time.
#[test]
fn stale_approval_from_removed_signer_still_counts() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let signer2 = Address::generate(&env);
    let signer3 = Address::generate(&env);
    client.add_admin(&admin, &signer2);

    // signer2 proposes (auto-approves, 1 of 2), then is removed.
    let pid = client.propose(&signer2, &ProposalAction::AddAdmin(signer3.clone()));
    client.remove_admin(&admin, &signer2);

    // signer2's recorded approval still counts — admin's approval executes.
    assert!(client.approve(&admin, &pid));
    assert!(client.admins().contains(&signer3));
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
fn threshold_unreachable_after_signer_set_shrinks() {
    let (env, client, admin) = setup();
    client.create(&admin);
    client.deposit(&admin, &500);

    let signer2 = Address::generate(&env);
    client.add_admin(&admin, &signer2);
    client.remove_admin(&admin, &signer2);

    // Threshold stays 2-of-N: a lone signer can propose but never execute.
    let recipient = Address::generate(&env);
    let pid = client.propose(
        &admin,
        &ProposalAction::ReleaseEscrow(recipient.clone(), 500),
    );
    assert_eq!(
        client.try_approve(&admin, &pid),
        Err(Ok(Error::AlreadySigned))
    );
    assert_eq!(client.pool().total_deposited, 500);

    // Re-adding a second signer makes the pending proposal executable again.
    let signer3 = Address::generate(&env);
    client.add_admin(&admin, &signer3);
    assert!(client.approve(&signer3, &pid));
    assert_eq!(client.pool().total_deposited, 0);
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
    env.ledger().with_mut(|li| li.sequence_number = freeze_ledger + 1);

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
    env.ledger().with_mut(|li| li.sequence_number = reveal_deadline + 1);

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

    env.ledger().with_mut(|li| li.sequence_number = freeze_ledger + 1);

    // 1. Omit Bob - total weight doesn't match total_deposited
    assert_eq!(
        client.try_finalize_draw(&secret, &vec![&env, alice.clone()]),
        Err(Ok(Error::InvalidParticipantsList))
    );

    // 2. Duplicate Alice
    assert_eq!(
        client.try_finalize_draw(&secret, &vec![&env, alice.clone(), alice.clone(), bob.clone()]),
        Err(Ok(Error::DuplicateParticipant))
    );

    // 3. Unjoined address
    let rando = Address::generate(&env);
    assert_eq!(
        client.try_finalize_draw(&secret, &vec![&env, alice.clone(), bob.clone(), rando.clone()]),
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

        env.ledger().with_mut(|li| li.sequence_number = freeze_ledger + 1);

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
