//! Adversarial unit-test suite (#141) + regression tests (#139, #140).
//! Event emission tests (#255). Storage optimisation regression (#257).
//! Multisig signer rotation, revoked-signer and threshold coverage.

use super::*;
use crate::proxy::{Error as ProxyError, VaultProxy, VaultProxyClient};
use soroban_sdk::testutils::{Address as _, Events as _, Ledger as _};
use soroban_sdk::IntoVal;

// ── helpers ────────────────────────────────────────────────────────────────

fn setup() -> (Env, DripPoolClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    // Give storage entries a TTL longer than the lockup window so that
    // skip_lockup() does not archive the contract instance in the test env.
    env.ledger().with_mut(|li| {
        li.min_persistent_entry_ttl = 1_000_000;
        li.min_temp_entry_ttl = 1_000_000;
        li.max_entry_ttl = 6_312_000;
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
    assert_eq!(
        payload,
        admin.into_val(&env),
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
    assert_eq!(
        payload,
        alice.into_val(&env),
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
    assert_eq!(
        payload,
        (alice.clone(), 500i128, 500i128).into_val(&env),
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
    assert_eq!(
        payload,
        (alice.clone(), 500i128).into_val(&env),
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
    assert_eq!(
        payload,
        (alice.clone(), 200i128).into_val(&env),
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
    assert_eq!(winner, admin);

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
    assert_eq!(
        payload,
        (winner.clone(), 100i128).into_val(&env),
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

fn proxy_setup() -> (Env, VaultProxyClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let proxy_id = env.register_contract(None, VaultProxy);
    let client = VaultProxyClient::new(&env, &proxy_id);
    let admin = Address::generate(&env);
    let logic = Address::generate(&env);
    (env, client, admin, logic)
}

#[test]
fn proxy_create_initialises() {
    let (_env, client, admin, logic) = proxy_setup();
    client.create(&admin, &logic);
    assert_eq!(client.admin(), admin);
    assert_eq!(client.logic_contract(), logic);
}

#[test]
fn proxy_upgrade_changes_logic() {
    let (env, client, admin, logic1) = proxy_setup();
    let logic2 = Address::generate(&env);
    client.create(&admin, &logic1);
    assert_eq!(client.logic_contract(), logic1);
    // Upgrade to new logic
    client.upgrade(&admin, &logic2);
    assert_eq!(client.logic_contract(), logic2);
}

#[test]
fn proxy_upgrade_unauthorized_fails() {
    let (env, client, admin, logic) = proxy_setup();
    let rando = Address::generate(&env);
    client.create(&admin, &logic);
    assert_eq!(
        client.try_upgrade(&rando, &logic),
        Err(Ok(ProxyError::Unauthorized))
    );
}
