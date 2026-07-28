//! #33 State-machine property tests and fuzzing for pool solvency.
//!
//! Each test generates a constrained sequence of commands across several actors
//! and ledger time, and replays every command against BOTH the reference model
//! (`model.rs`) and the real `DripPool` contract. After each step it asserts:
//!
//!   - the two agree on accept/reject and on the returned value;
//!   - a rejected call leaves the contract's observable state unchanged;
//!   - the solvency invariants hold on the contract's actual state.
//!
//! proptest shrinks any failure to a minimal command sequence and prints the
//! seed, so a red run reproduces deterministically.
//!
//! Scope matches `model.rs`: the balance/solvency entrypoints. Governance and
//! the raffle draw state machine are covered by the contract's own tests.
//!
//! Budget: the default case count is small enough for PR CI. Set
//! `PROPTEST_CASES` (proptest reads it automatically) higher for a nightly run,
//! e.g. `PROPTEST_CASES=20000 cargo test -p drip-pool solvency`.

extern crate std;

use crate::model::{Model, ModelError};
use crate::{DripPool, DripPoolClient, Error, Participant};
use proptest::prelude::*;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{Address, Env};
use std::vec::Vec as StdVec;

/// Number of distinct actors the commands range over. Index 0 is the creator.
const ACTORS: u8 = 4;
/// Ledger sequence the harness starts at, so lockup deadlines are meaningful.
const START_SEQ: u32 = 100;

/// One generated action over the solvency surface.
#[derive(Clone, Debug)]
enum Cmd {
    Create,
    Join(u8),
    Deposit(u8, i128),
    DepositDur(u8, i128, u32),
    Claim(u8),
    Withdraw(u8),
    Advance(u32),
}

fn actor_strategy() -> impl Strategy<Value = u8> {
    0u8..ACTORS
}

/// Amounts deliberately include 0 and a negative value to exercise the
/// InvalidAmount path, and are otherwise bounded well below i128::MAX so the
/// differential loop is not conflated with the dedicated overflow test.
fn amount_strategy() -> impl Strategy<Value = i128> {
    prop_oneof![
        1 => Just(0i128),
        1 => Just(-1i128),
        8 => 1i128..1_000_000_000i128,
    ]
}

fn days_strategy() -> impl Strategy<Value = u32> {
    prop_oneof![
        Just(0u32),
        Just(3u32),
        Just(10u32),
        Just(20u32),
        Just(120u32)
    ]
}

fn cmd_strategy() -> impl Strategy<Value = Cmd> {
    prop_oneof![
        1 => Just(Cmd::Create),
        3 => actor_strategy().prop_map(Cmd::Join),
        6 => (actor_strategy(), amount_strategy()).prop_map(|(a, m)| Cmd::Deposit(a, m)),
        4 => (actor_strategy(), amount_strategy(), days_strategy())
            .prop_map(|(a, m, d)| Cmd::DepositDur(a, m, d)),
        3 => actor_strategy().prop_map(Cmd::Claim),
        3 => actor_strategy().prop_map(Cmd::Withdraw),
        3 => (0u32..200_000u32).prop_map(Cmd::Advance),
    ]
}

struct Harness {
    env: Env,
    client: DripPoolClient<'static>,
    actors: StdVec<Address>,
}

fn setup() -> Harness {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| {
        li.sequence_number = START_SEQ;
        li.timestamp = 1;
        li.min_persistent_entry_ttl = 10_000_000;
        li.min_temp_entry_ttl = 10_000_000;
        li.max_entry_ttl = 20_000_000;
    });
    let id = env.register_contract(None, DripPool);
    let client = DripPoolClient::new(&env, &id);
    let actors: StdVec<Address> = (0..ACTORS).map(|_| Address::generate(&env)).collect();
    Harness {
        env,
        client,
        actors,
    }
}

fn expected_error(e: ModelError) -> Error {
    match e {
        ModelError::AlreadyInitialized => Error::AlreadyInitialized,
        ModelError::NotInitialized => Error::NotInitialized,
        ModelError::AlreadyJoined => Error::AlreadyJoined,
        ModelError::NotJoined => Error::NotJoined,
        ModelError::InvalidAmount => Error::InvalidAmount,
        ModelError::LockupActive => Error::LockupActive,
        ModelError::MathOverflow => Error::MathOverflow,
    }
}

/// The solvency-relevant fields of a participant, independent of the cosmetic
/// `joined_at` timestamp which the model does not track.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Balances {
    deposited: i128,
    claimable: i128,
    locked_until: u32,
    lockup_multiplier: u32,
}

impl From<Participant> for Balances {
    fn from(p: Participant) -> Self {
        Self {
            deposited: p.deposited,
            claimable: p.claimable,
            locked_until: p.locked_until,
            lockup_multiplier: p.lockup_multiplier,
        }
    }
}

/// Everything about the contract a caller can observe, for the
/// rejected-call-leaves-state-unchanged check.
#[derive(Clone, Debug, PartialEq)]
struct Snapshot {
    total_deposited: Option<i128>,
    total_drips: Option<u64>,
    balances: StdVec<Option<Balances>>,
}

impl Harness {
    fn snapshot(&self) -> Snapshot {
        let pool = self.client.try_pool().ok().and_then(|r| r.ok());
        let balances = self
            .actors
            .iter()
            .map(|a| {
                self.client
                    .try_savings(a)
                    .ok()
                    .and_then(|r| r.ok())
                    .map(Balances::from)
            })
            .collect();
        Snapshot {
            total_deposited: pool.as_ref().map(|p| p.total_deposited),
            total_drips: pool.as_ref().map(|p| p.total_drips),
            balances,
        }
    }

    /// Cross-check the contract's own state against the model and the invariants.
    fn assert_agrees(&self, model: &Model) {
        model.check_conservation();
        model.check_balances();

        if let Some(pool) = self.client.try_pool().ok().and_then(|r| r.ok()) {
            assert_eq!(
                pool.total_deposited, model.total_deposited,
                "total_deposited"
            );
            assert_eq!(pool.total_drips, model.total_drips, "total_drips");
            assert!(
                !pool.locked,
                "reentrancy lock must be released after every call"
            );

            // The contract's own pool total must equal the sum of the principal
            // it still reports for each actor: solvency, checked on chain.
            let on_chain_sum: i128 = self
                .actors
                .iter()
                .filter_map(|a| self.client.try_savings(a).ok().and_then(|r| r.ok()))
                .map(|p| p.deposited)
                .sum();
            assert_eq!(
                pool.total_deposited, on_chain_sum,
                "on-chain total_deposited must equal sum of participant principal",
            );
        }

        for (i, addr) in self.actors.iter().enumerate() {
            let on_chain = self
                .client
                .try_savings(addr)
                .ok()
                .and_then(|r| r.ok())
                .map(Balances::from);
            let modelled = model.participants.get(&(i as u8)).map(|p| Balances {
                deposited: p.deposited,
                claimable: p.claimable,
                locked_until: p.locked_until,
                lockup_multiplier: p.lockup_multiplier,
            });
            assert_eq!(on_chain, modelled, "participant {i} balances diverged");
        }
    }
}

/// Apply one command to both systems and assert they agree. Rejected calls are
/// checked to leave the observable state unchanged.
fn step(h: &Harness, model: &mut Model, cmd: &Cmd) {
    // The harness drives far more operations through one Env than a real
    // transaction ever would, so the cumulative host budget would trip
    // ExceededLimit. Cost is metered separately by scripts/measure_costs.sh;
    // here we reset it so resource metering never masks a correctness result.
    h.env.budget().reset_unlimited();
    let before = h.snapshot();
    let c = &h.client;
    let a = &h.actors;

    let rejected: bool = match *cmd {
        Cmd::Create => match model.create() {
            Ok(()) => {
                c.try_create(&a[0]).unwrap().unwrap();
                false
            }
            Err(e) => {
                assert_eq!(c.try_create(&a[0]), Err(Ok(expected_error(e))));
                true
            }
        },
        Cmd::Join(who) => match model.join(who) {
            Ok(()) => {
                c.try_join(&a[who as usize]).unwrap().unwrap();
                false
            }
            Err(e) => {
                assert_eq!(c.try_join(&a[who as usize]), Err(Ok(expected_error(e))));
                true
            }
        },
        Cmd::Deposit(who, amount) => {
            let got = c.try_deposit(&a[who as usize], &amount);
            match model.deposit(who, amount) {
                Ok(()) => {
                    got.unwrap().unwrap();
                    false
                }
                Err(e) => {
                    assert_eq!(got, Err(Ok(expected_error(e))));
                    true
                }
            }
        }
        Cmd::DepositDur(who, amount, days) => {
            let got = c.try_deposit_with_duration(&a[who as usize], &amount, &days);
            match model.deposit_with_duration(who, amount, days) {
                Ok(()) => {
                    got.unwrap().unwrap();
                    false
                }
                Err(e) => {
                    assert_eq!(got, Err(Ok(expected_error(e))));
                    true
                }
            }
        }
        Cmd::Claim(who) => {
            let got = c.try_claim(&a[who as usize]);
            match model.claim(who) {
                Ok(v) => {
                    assert_eq!(got, Ok(Ok(v)));
                    false
                }
                Err(e) => {
                    assert_eq!(got, Err(Ok(expected_error(e))));
                    true
                }
            }
        }
        Cmd::Withdraw(who) => {
            let got = c.try_withdraw(&a[who as usize]);
            match model.withdraw(who) {
                Ok(v) => {
                    assert_eq!(got, Ok(Ok(v)));
                    false
                }
                Err(e) => {
                    assert_eq!(got, Err(Ok(expected_error(e))));
                    true
                }
            }
        }
        Cmd::Advance(by) => {
            model.advance_ledger(by);
            h.env
                .ledger()
                .with_mut(|li| li.sequence_number = li.sequence_number.saturating_add(by));
            false
        }
    };

    if rejected {
        assert_eq!(
            h.snapshot(),
            before,
            "rejected call must not change state: {cmd:?}"
        );
    }
    h.assert_agrees(model);
}

fn run(cmds: &[Cmd]) {
    let h = setup();
    let mut model = Model {
        ledger_seq: START_SEQ,
        ..Model::default()
    };
    for cmd in cmds {
        step(&h, &mut model, cmd);
    }
}

proptest! {
    // Modest default for PR CI; raise PROPTEST_CASES for nightly depth.
    #![proptest_config(ProptestConfig { cases: 48, ..ProptestConfig::default() })]

    #[test]
    fn solvency_state_machine(cmds in proptest::collection::vec(cmd_strategy(), 1..24)) {
        run(&cmds);
    }
}

// ── Seeded regression traces (required cases) ───────────────────────────────

#[test]
fn seeded_repeated_claim_pays_once() {
    run(&[
        Cmd::Create,
        Cmd::Deposit(1, 500),
        Cmd::Claim(1),
        Cmd::Claim(1), // second claim returns 0, not a double-pay
    ]);
}

#[test]
fn seeded_lock_expiry() {
    // A 20-day lockup blocks withdrawal until enough ledgers pass.
    run(&[
        Cmd::Create,
        Cmd::DepositDur(1, 1_000, 20),
        Cmd::Withdraw(1), // LockupActive
        Cmd::Advance(90 * 17_280 + 1),
        Cmd::Withdraw(1), // now allowed
    ]);
}

#[test]
fn seeded_withdraw_is_one_time_and_conserves() {
    run(&[
        Cmd::Create,
        Cmd::Deposit(1, 1_000),
        Cmd::Deposit(2, 400),
        Cmd::Advance(200_000),
        Cmd::Withdraw(1),
        Cmd::Withdraw(1), // NotJoined the second time
    ]);
}

#[test]
fn seeded_withdraw_before_create_is_not_initialized() {
    // join does not require the pool; withdraw does (it reads Pool for the
    // reentrancy lock), so a join-then-withdraw with no create is NotInitialized.
    run(&[Cmd::Join(1), Cmd::Advance(200_000), Cmd::Withdraw(1)]);
}

// ── Targeted fuzz: arithmetic overflow ──────────────────────────────────────

#[test]
fn deposit_overflow_is_rejected_and_leaves_state_unchanged() {
    let h = setup();
    h.client.create(&h.actors[0]);
    h.client.deposit(&h.actors[1], &(i128::MAX - 10));

    let before = h.snapshot();
    // This addition overflows i128; the guard must turn it into a clean error,
    // not a panic or a silent wrap that corrupts the pool total.
    let got = h.client.try_deposit(&h.actors[1], &100);
    assert_eq!(got, Err(Ok(Error::MathOverflow)));
    assert_eq!(
        h.snapshot(),
        before,
        "overflow-rejected deposit must not change state"
    );
}

#[test]
fn total_deposited_overflow_is_rejected() {
    let h = setup();
    h.client.create(&h.actors[0]);
    // Two participants each near the max: individually fine, but the second
    // deposit overflows the pool-wide total_deposited.
    h.client.deposit(&h.actors[1], &(i128::MAX - 10));
    let got = h.client.try_deposit(&h.actors[2], &100);
    assert_eq!(got, Err(Ok(Error::MathOverflow)));
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 64, ..ProptestConfig::default() })]

    /// Fuzz the withdraw payout math: for any principal and lockup tier, the
    /// yield-boosted payout is never less than principal, and the saturating
    /// math never panics.
    #[test]
    fn withdraw_payout_is_bounded(principal in 1i128..1_000_000_000_000i128, days in 0u32..400u32) {
        let h = setup();
        h.env.budget().reset_unlimited();
        h.client.create(&h.actors[0]);
        h.client.deposit_with_duration(&h.actors[1], &principal, &days);
        h.env.ledger().with_mut(|li| li.sequence_number = li.sequence_number.saturating_add(90 * 17_280 + 1));
        let payout = h.client.withdraw(&h.actors[1]);
        prop_assert!(payout >= principal, "payout {payout} < principal {principal}");
    }
}
