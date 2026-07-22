//! #72 dilution-safe NAV share accounting: pure snapshot math only — no `Env`/`Address`/auth; the contract layer owns persistence, authorization, and events.

use super::*;

/// Fixed-point scale for `high_water_mark` and other price-per-share values.
pub const PPS_SCALE: i128 = 1_000_000_000_000;

// ERC4626-style decimals offset: keeps the ratio safe at zero/near-zero real supply, which is what defeats the donation attack without special-casing it.
const VIRTUAL_SHARES: i128 = 1_000_000;
const VIRTUAL_ASSETS: i128 = 1;

const SECONDS_PER_YEAR: i128 = 365 * 24 * 60 * 60;
const BPS_DENOMINATOR: i128 = 10_000;

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct VaultSnapshot {
    pub total_shares: i128,
    pub total_assets: i128,
    pub pending_withdrawals: i128,
    pub accrued_fees: i128,
    pub donated_assets: i128,
    pub dust: i128,
    pub high_water_mark: i128,
    pub last_fee_time: u64,
    pub version: u64,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct WithdrawalRequest {
    pub assets_owed: i128,
    pub assets_paid: i128,
}

/// Numbers a caller needs to assert/emit the post-deposit invariant.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct DepositReceipt {
    pub shares_minted: i128,
    pub price_per_share_before: i128,
    pub price_per_share_after: i128,
    pub version: u64,
}

impl VaultSnapshot {
    pub fn new(now: u64) -> Result<Self, Error> {
        let mut snapshot = VaultSnapshot {
            total_shares: 0,
            total_assets: 0,
            pending_withdrawals: 0,
            accrued_fees: 0,
            donated_assets: 0,
            dust: 0,
            high_water_mark: 0,
            last_fee_time: now,
            version: 0,
        };
        snapshot.high_water_mark = price_per_share(&snapshot)?;
        Ok(snapshot)
    }
}

fn checked_mul_div(a: i128, b: i128, denom: i128) -> Result<(i128, i128), Error> {
    if denom <= 0 {
        return Err(Error::MathOverflow);
    }
    let product = a.checked_mul(b).ok_or(Error::MathOverflow)?;
    let quotient = product.checked_div(denom).ok_or(Error::MathOverflow)?;
    let remainder = product.checked_rem(denom).ok_or(Error::MathOverflow)?;
    Ok((quotient, remainder))
}

fn mul_div_floor(a: i128, b: i128, denom: i128) -> Result<i128, Error> {
    checked_mul_div(a, b, denom).map(|(quotient, _)| quotient)
}

fn mul_div_ceil(a: i128, b: i128, denom: i128) -> Result<i128, Error> {
    let (quotient, remainder) = checked_mul_div(a, b, denom)?;
    if remainder == 0 {
        Ok(quotient)
    } else {
        quotient.checked_add(1).ok_or(Error::MathOverflow)
    }
}

/// Assets backing outstanding shares — never derived from a raw token balance, so a bare transfer into the vault can't move this (see `note_donation`).
fn net_assets(snapshot: &VaultSnapshot) -> Result<i128, Error> {
    snapshot
        .total_assets
        .checked_sub(snapshot.pending_withdrawals)
        .and_then(|value| value.checked_sub(snapshot.accrued_fees))
        .ok_or(Error::MathOverflow)
}

fn virtual_shares(snapshot: &VaultSnapshot) -> Result<i128, Error> {
    snapshot
        .total_shares
        .checked_add(VIRTUAL_SHARES)
        .ok_or(Error::MathOverflow)
}

fn virtual_assets(snapshot: &VaultSnapshot) -> Result<i128, Error> {
    net_assets(snapshot)?
        .checked_add(VIRTUAL_ASSETS)
        .ok_or(Error::MathOverflow)
}

pub fn price_per_share(snapshot: &VaultSnapshot) -> Result<i128, Error> {
    mul_div_floor(
        virtual_assets(snapshot)?,
        PPS_SCALE,
        virtual_shares(snapshot)?,
    )
}

fn shares_for_deposit(snapshot: &VaultSnapshot, assets: i128) -> Result<i128, Error> {
    mul_div_floor(assets, virtual_shares(snapshot)?, virtual_assets(snapshot)?)
}

fn assets_for_redeem(snapshot: &VaultSnapshot, shares: i128) -> Result<i128, Error> {
    mul_div_floor(shares, virtual_assets(snapshot)?, virtual_shares(snapshot)?)
}

fn assets_for_mint(snapshot: &VaultSnapshot, shares: i128) -> Result<i128, Error> {
    mul_div_ceil(shares, virtual_assets(snapshot)?, virtual_shares(snapshot)?)
}

fn shares_for_withdraw(snapshot: &VaultSnapshot, assets: i128) -> Result<i128, Error> {
    mul_div_ceil(assets, virtual_shares(snapshot)?, virtual_assets(snapshot)?)
}

fn compute_deposit_shares(snapshot: &VaultSnapshot, assets: i128) -> Result<i128, Error> {
    if assets <= 0 {
        return Err(Error::InvalidAmount);
    }
    let shares = shares_for_deposit(snapshot, assets)?;
    if shares <= 0 {
        return Err(Error::RoundsToZero);
    }
    Ok(shares)
}

fn compute_redeem_assets(snapshot: &VaultSnapshot, shares: i128) -> Result<i128, Error> {
    if shares <= 0 {
        return Err(Error::InvalidAmount);
    }
    if shares > snapshot.total_shares {
        return Err(Error::InsufficientShares);
    }
    let assets = assets_for_redeem(snapshot, shares)?;
    if assets <= 0 {
        return Err(Error::RoundsToZero);
    }
    Ok(assets)
}

/// Matches `deposit`'s result when called against the same (unchanged) snapshot.
pub fn preview_deposit(snapshot: &VaultSnapshot, assets: i128) -> Result<i128, Error> {
    compute_deposit_shares(snapshot, assets)
}

/// Matches `request_withdrawal`'s `assets_owed` when called against the same (unchanged) snapshot.
pub fn preview_redeem(snapshot: &VaultSnapshot, shares: i128) -> Result<i128, Error> {
    compute_redeem_assets(snapshot, shares)
}

/// Rounds up (the complementary direction to `preview_deposit`) — no stateful `mint` entry point is wired up, but the primitive is available.
pub fn preview_mint(snapshot: &VaultSnapshot, shares: i128) -> Result<i128, Error> {
    if shares <= 0 {
        return Err(Error::InvalidAmount);
    }
    assets_for_mint(snapshot, shares)
}

/// Rounds up — the complementary direction to `preview_redeem`.
pub fn preview_withdraw(snapshot: &VaultSnapshot, assets: i128) -> Result<i128, Error> {
    if assets <= 0 {
        return Err(Error::InvalidAmount);
    }
    if assets > net_assets(snapshot)? {
        return Err(Error::InsufficientBalance);
    }
    shares_for_withdraw(snapshot, assets)
}

fn bump_version(snapshot: &mut VaultSnapshot) -> Result<(), Error> {
    snapshot.version = snapshot.version.checked_add(1).ok_or(Error::MathOverflow)?;
    Ok(())
}

pub fn deposit(
    snapshot: &mut VaultSnapshot,
    assets: i128,
    expected_version: u64,
) -> Result<DepositReceipt, Error> {
    if snapshot.version != expected_version {
        return Err(Error::StaleSnapshot);
    }
    let price_per_share_before = price_per_share(snapshot)?;
    let shares = compute_deposit_shares(snapshot, assets)?;

    snapshot.total_assets = snapshot
        .total_assets
        .checked_add(assets)
        .ok_or(Error::MathOverflow)?;
    snapshot.total_shares = snapshot
        .total_shares
        .checked_add(shares)
        .ok_or(Error::MathOverflow)?;
    bump_version(snapshot)?;

    let price_per_share_after = price_per_share(snapshot)?;
    Ok(DepositReceipt {
        shares_minted: shares,
        price_per_share_before,
        price_per_share_after,
        version: snapshot.version,
    })
}

/// Burns `shares` now and queues `assets_owed` as a liability, so remaining holders' price per share can't be affected by when the payout happens.
pub fn request_withdrawal(
    snapshot: &mut VaultSnapshot,
    shares: i128,
    expected_version: u64,
) -> Result<WithdrawalRequest, Error> {
    if snapshot.version != expected_version {
        return Err(Error::StaleSnapshot);
    }
    let assets_owed = compute_redeem_assets(snapshot, shares)?;

    snapshot.total_shares = snapshot
        .total_shares
        .checked_sub(shares)
        .ok_or(Error::MathOverflow)?;
    snapshot.pending_withdrawals = snapshot
        .pending_withdrawals
        .checked_add(assets_owed)
        .ok_or(Error::MathOverflow)?;

    if snapshot.total_shares == 0 {
        let leftover = net_assets(snapshot)?;
        if leftover > 0 {
            snapshot.total_assets = snapshot
                .total_assets
                .checked_sub(leftover)
                .ok_or(Error::MathOverflow)?;
            snapshot.dust = snapshot
                .dust
                .checked_add(leftover)
                .ok_or(Error::MathOverflow)?;
        }
        // No shares left means no prior gain to protect — reset the ratchet for the next depositor generation.
        snapshot.high_water_mark = price_per_share(snapshot)?;
    }
    bump_version(snapshot)?;

    Ok(WithdrawalRequest {
        assets_owed,
        assets_paid: 0,
    })
}

/// Pays down up to `amount` of a queued request; callable repeatedly until `assets_paid == assets_owed`.
pub fn fulfill_withdrawal(
    snapshot: &mut VaultSnapshot,
    request: &mut WithdrawalRequest,
    amount: i128,
) -> Result<i128, Error> {
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }
    let remaining = request
        .assets_owed
        .checked_sub(request.assets_paid)
        .ok_or(Error::MathOverflow)?;
    if remaining <= 0 {
        return Err(Error::WithdrawalAlreadySettled);
    }
    if amount > remaining {
        return Err(Error::ExceedsOwed);
    }
    if amount > snapshot.total_assets {
        return Err(Error::InsufficientBalance);
    }

    snapshot.total_assets = snapshot
        .total_assets
        .checked_sub(amount)
        .ok_or(Error::MathOverflow)?;
    snapshot.pending_withdrawals = snapshot
        .pending_withdrawals
        .checked_sub(amount)
        .ok_or(Error::MathOverflow)?;
    request.assets_paid = request
        .assets_paid
        .checked_add(amount)
        .ok_or(Error::MathOverflow)?;
    bump_version(snapshot)?;

    Ok(amount)
}

/// Pro-rata time-based fee on `net_assets`. Always advances `last_fee_time` so a rate enabled later only accrues from that point forward.
pub fn accrue_management_fee(
    snapshot: &mut VaultSnapshot,
    now: u64,
    annual_rate_bps: u32,
) -> Result<i128, Error> {
    if now < snapshot.last_fee_time {
        return Err(Error::StaleSnapshot);
    }
    let elapsed = (now - snapshot.last_fee_time) as i128;
    snapshot.last_fee_time = now;
    bump_version(snapshot)?;

    if elapsed == 0 || annual_rate_bps == 0 {
        return Ok(0);
    }
    let rate_seconds = (annual_rate_bps as i128)
        .checked_mul(elapsed)
        .ok_or(Error::MathOverflow)?;
    let year_bps = BPS_DENOMINATOR
        .checked_mul(SECONDS_PER_YEAR)
        .ok_or(Error::MathOverflow)?;
    let fee = mul_div_floor(net_assets(snapshot)?, rate_seconds, year_bps)?;
    snapshot.accrued_fees = snapshot
        .accrued_fees
        .checked_add(fee)
        .ok_or(Error::MathOverflow)?;
    Ok(fee)
}

/// Fee on the gain above the high-water mark; the mark then ratchets to the *post-fee* price so the same gain can never be charged twice.
pub fn accrue_performance_fee(
    snapshot: &mut VaultSnapshot,
    performance_fee_bps: u32,
) -> Result<i128, Error> {
    bump_version(snapshot)?;
    if performance_fee_bps == 0 {
        return Ok(0);
    }

    let current_pps = price_per_share(snapshot)?;
    if current_pps <= snapshot.high_water_mark {
        return Ok(0);
    }
    let gain_per_share = current_pps - snapshot.high_water_mark;
    let total_gain = mul_div_floor(gain_per_share, virtual_shares(snapshot)?, PPS_SCALE)?;
    let fee = mul_div_floor(total_gain, performance_fee_bps as i128, BPS_DENOMINATOR)?;
    if fee <= 0 {
        return Ok(0);
    }

    snapshot.accrued_fees = snapshot
        .accrued_fees
        .checked_add(fee)
        .ok_or(Error::MathOverflow)?;
    let new_pps = price_per_share(snapshot)?;
    if new_pps > snapshot.high_water_mark {
        snapshot.high_water_mark = new_pps;
    }
    Ok(fee)
}

pub fn report_gain(snapshot: &mut VaultSnapshot, amount: i128) -> Result<(), Error> {
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }
    snapshot.total_assets = snapshot
        .total_assets
        .checked_add(amount)
        .ok_or(Error::MathOverflow)?;
    bump_version(snapshot)
}

/// Can only eat into the value backing outstanding shares — never what's already owed to withdrawers or fees.
pub fn report_loss(snapshot: &mut VaultSnapshot, amount: i128) -> Result<(), Error> {
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }
    if amount > net_assets(snapshot)? {
        return Err(Error::InsufficientBalance);
    }
    snapshot.total_assets = snapshot
        .total_assets
        .checked_sub(amount)
        .ok_or(Error::MathOverflow)?;
    bump_version(snapshot)
}

/// Records an out-of-band transfer into the vault without it affecting price per share.
pub fn note_donation(snapshot: &mut VaultSnapshot, amount: i128) -> Result<(), Error> {
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }
    snapshot.donated_assets = snapshot
        .donated_assets
        .checked_add(amount)
        .ok_or(Error::MathOverflow)?;
    bump_version(snapshot)
}

/// Deliberately promotes previously-noted donations into real NAV.
pub fn recognize_donation(snapshot: &mut VaultSnapshot, amount: i128) -> Result<(), Error> {
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }
    if amount > snapshot.donated_assets {
        return Err(Error::InsufficientBalance);
    }
    snapshot.donated_assets -= amount;
    snapshot.total_assets = snapshot
        .total_assets
        .checked_add(amount)
        .ok_or(Error::MathOverflow)?;
    bump_version(snapshot)
}

pub fn sweep_dust(snapshot: &mut VaultSnapshot) -> Result<i128, Error> {
    if snapshot.dust <= 0 {
        return Err(Error::NothingToSweep);
    }
    let amount = snapshot.dust;
    snapshot.dust = 0;
    bump_version(snapshot)?;
    Ok(amount)
}

pub fn claim_fees(snapshot: &mut VaultSnapshot, amount: i128) -> Result<(), Error> {
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }
    if amount > snapshot.accrued_fees {
        return Err(Error::InsufficientBalance);
    }
    snapshot.accrued_fees -= amount;
    snapshot.total_assets = snapshot
        .total_assets
        .checked_sub(amount)
        .ok_or(Error::MathOverflow)?;
    bump_version(snapshot)
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::*;

    fn fresh() -> VaultSnapshot {
        VaultSnapshot::new(0).unwrap()
    }

    fn deposit_next(snap: &mut VaultSnapshot, assets: i128) -> Result<DepositReceipt, Error> {
        let version = snap.version;
        deposit(snap, assets, version)
    }

    fn redeem_all(snap: &mut VaultSnapshot) -> Result<WithdrawalRequest, Error> {
        let all_shares = snap.total_shares;
        let version = snap.version;
        request_withdrawal(snap, all_shares, version)
    }

    // ── first deposit / near-zero supply / rounding direction ──────────────

    #[test]
    fn first_deposit_mints_shares_at_the_virtual_baseline() {
        let mut snap = fresh();
        let receipt = deposit(&mut snap, 1_000_000, 0).unwrap();
        assert_eq!(receipt.shares_minted, 1_000_000 * VIRTUAL_SHARES);
        assert_eq!(snap.total_assets, 1_000_000);
        assert_eq!(snap.total_shares, 1_000_000 * VIRTUAL_SHARES);
    }

    #[test]
    fn equal_deposits_get_equal_shares() {
        let mut snap = fresh();
        let first = deposit(&mut snap, 500, 0).unwrap().shares_minted;
        let second = deposit_next(&mut snap, 500).unwrap().shares_minted;
        assert_eq!(first, second);
    }

    #[test]
    fn deposit_rejects_non_positive_amount() {
        let mut snap = fresh();
        assert_eq!(deposit(&mut snap, 0, 0), Err(Error::InvalidAmount));
        assert_eq!(deposit(&mut snap, -5, 0), Err(Error::InvalidAmount));
    }

    #[test]
    fn deposit_rejects_stale_version() {
        let mut snap = fresh();
        assert_eq!(deposit(&mut snap, 100, 41), Err(Error::StaleSnapshot));
    }

    #[test]
    fn deposit_too_small_to_mint_a_share_is_rejected_not_silently_absorbed() {
        // net_assets so far outweighs total_shares that 1 new unit buys less than one share.
        let mut snap = VaultSnapshot {
            total_shares: 0,
            total_assets: 2_000_000,
            ..fresh()
        };
        assert_eq!(deposit(&mut snap, 1, 0), Err(Error::RoundsToZero));
        // Untouched — no silent value transfer.
        assert_eq!(snap.total_assets, 2_000_000);
        assert_eq!(snap.version, 0);
    }

    #[test]
    fn redeem_rejects_more_shares_than_exist() {
        let mut snap = fresh();
        deposit(&mut snap, 100, 0).unwrap();
        let too_many = snap.total_shares + 1;
        let version = snap.version;
        assert_eq!(
            request_withdrawal(&mut snap, too_many, version),
            Err(Error::InsufficientShares)
        );
    }

    #[test]
    fn single_depositor_round_trip_is_exact() {
        let mut snap = fresh();
        deposit(&mut snap, 12_345, 0).unwrap();
        let request = redeem_all(&mut snap).unwrap();
        assert_eq!(request.assets_owed, 12_345);
    }

    #[test]
    fn rounding_favors_existing_holders_on_redeem_vs_mint() {
        let snap = VaultSnapshot {
            total_shares: 3_000_000_000,
            total_assets: 10_000_000_000,
            ..fresh()
        };
        // Same shares quantity: redeeming (assets out) floors, minting (assets required) ceils.
        assert_eq!(preview_redeem(&snap, 1), Ok(3));
        assert_eq!(preview_mint(&snap, 1), Ok(4));
    }

    #[test]
    fn rounding_favors_existing_holders_on_deposit_vs_withdraw() {
        let snap = VaultSnapshot {
            total_shares: 3_000_000_000,
            total_assets: 10_000_000_000,
            ..fresh()
        };
        // Same assets quantity: depositing (shares minted) floors, withdrawing (shares burned) ceils.
        assert_eq!(preview_deposit(&snap, 4), Ok(1));
        assert_eq!(preview_withdraw(&snap, 4), Ok(2));
    }

    #[test]
    fn mixed_magnitude_deposits_stay_proportional() {
        let mut snap = fresh();
        let whale = deposit(&mut snap, 1_000_000_000, 0).unwrap().shares_minted;
        let minnow = deposit_next(&mut snap, 1).unwrap().shares_minted;
        // A billionth of the whale's deposit, but still strictly positive and proportionally fair.
        assert!(minnow > 0);
        assert!(minnow < whale);
    }

    // ── preview == execute ──────────────────────────────────────────────────

    #[test]
    fn preview_deposit_matches_executed_deposit() {
        let mut snap = fresh();
        deposit(&mut snap, 777, 0).unwrap();
        let previewed = preview_deposit(&snap, 250).unwrap();
        let executed = deposit_next(&mut snap, 250).unwrap();
        assert_eq!(previewed, executed.shares_minted);
    }

    #[test]
    fn preview_redeem_matches_executed_withdrawal_request() {
        let mut snap = fresh();
        deposit(&mut snap, 9_000, 0).unwrap();
        let redeem_shares = snap.total_shares / 3;
        let previewed = preview_redeem(&snap, redeem_shares).unwrap();
        let version = snap.version;
        let executed = request_withdrawal(&mut snap, redeem_shares, version).unwrap();
        assert_eq!(previewed, executed.assets_owed);
    }

    // ── donation isolation / inflation-attack resistance ────────────────────

    #[test]
    fn donation_does_not_move_price_until_recognized() {
        let mut snap = fresh();
        deposit(&mut snap, 1_000, 0).unwrap();
        let price_before = price_per_share(&snap).unwrap();

        note_donation(&mut snap, 1_000_000_000).unwrap();
        assert_eq!(price_per_share(&snap).unwrap(), price_before);
        assert_eq!(snap.donated_assets, 1_000_000_000);

        recognize_donation(&mut snap, 1_000_000_000).unwrap();
        assert!(price_per_share(&snap).unwrap() > price_before);
    }

    #[test]
    fn recognize_donation_cannot_exceed_noted_amount() {
        let mut snap = fresh();
        note_donation(&mut snap, 100).unwrap();
        assert_eq!(
            recognize_donation(&mut snap, 101),
            Err(Error::InsufficientBalance)
        );
    }

    #[test]
    fn classic_inflation_attack_does_not_rob_the_second_depositor() {
        // Attacker deposits dust, then donates a huge amount before the victim's deposit lands.
        let mut snap = fresh();
        deposit(&mut snap, 1, 0).unwrap();
        note_donation(&mut snap, 1_000_000_000).unwrap();
        recognize_donation(&mut snap, 1_000_000_000).unwrap();

        let victim_deposit = 1_000_000;
        let victim_shares = deposit_next(&mut snap, victim_deposit)
            .unwrap()
            .shares_minted;
        assert!(
            victim_shares > 0,
            "victim must receive non-zero shares for a real deposit"
        );

        // The donation must not have transferred the victim's value to the attacker.
        let victim_redeemable = preview_redeem(&snap, victim_shares).unwrap();
        assert!(victim_redeemable * 100 >= victim_deposit * 99);
    }

    // ── dust: full exit leaves nothing orphaned ─────────────────────────────

    #[test]
    fn full_exit_sweeps_remainder_into_dust_with_nothing_left_orphaned() {
        let mut snap = fresh();
        deposit(&mut snap, 1_000_000, 0).unwrap();
        report_gain(&mut snap, 1).unwrap(); // tiny odd gain to force a rounding remainder
        redeem_all(&mut snap).unwrap();

        assert_eq!(snap.total_shares, 0);
        assert_eq!(net_assets(&snap).unwrap(), 0);
        assert!(snap.dust <= 1);
    }

    #[test]
    fn sweep_dust_requires_a_positive_balance() {
        let mut snap = fresh();
        assert_eq!(sweep_dust(&mut snap), Err(Error::NothingToSweep));
    }

    #[test]
    fn sweep_dust_drains_exactly_and_only_once() {
        let mut snap = fresh();
        snap.dust = 42;
        assert_eq!(sweep_dust(&mut snap), Ok(42));
        assert_eq!(snap.dust, 0);
        assert_eq!(sweep_dust(&mut snap), Err(Error::NothingToSweep));
    }

    // ── high-water-mark performance fee ──────────────────────────────────────

    #[test]
    fn performance_fee_charges_nothing_without_a_gain() {
        let mut snap = fresh();
        deposit(&mut snap, 1_000_000, 0).unwrap();
        assert_eq!(accrue_performance_fee(&mut snap, 2_000).unwrap(), 0);
    }

    #[test]
    fn performance_fee_cannot_charge_the_same_gain_twice() {
        let mut snap = fresh();
        deposit(&mut snap, 1_000_000, 0).unwrap();
        report_gain(&mut snap, 500_000).unwrap();

        let first_charge = accrue_performance_fee(&mut snap, 2_000).unwrap();
        assert!(first_charge > 0);
        let second_charge = accrue_performance_fee(&mut snap, 2_000).unwrap();
        assert_eq!(second_charge, 0, "no new gain since the last checkpoint");
    }

    #[test]
    fn performance_fee_survives_a_loss_and_only_taxes_new_gains_on_recovery() {
        let mut snap = fresh();
        deposit(&mut snap, 1_000_000, 0).unwrap();
        report_gain(&mut snap, 500_000).unwrap();
        accrue_performance_fee(&mut snap, 2_000).unwrap();
        let hwm_after_first_charge = snap.high_water_mark;

        report_loss(&mut snap, 300_000).unwrap();
        assert_eq!(
            accrue_performance_fee(&mut snap, 2_000).unwrap(),
            0,
            "a drawdown below the high-water mark owes nothing"
        );
        assert_eq!(snap.high_water_mark, hwm_after_first_charge);

        report_gain(&mut snap, 150_000).unwrap();
        assert_eq!(
            accrue_performance_fee(&mut snap, 2_000).unwrap(),
            0,
            "recovering back up to (not past) the old peak still owes nothing"
        );

        report_gain(&mut snap, 500_000).unwrap();
        let recovery_charge = accrue_performance_fee(&mut snap, 2_000).unwrap();
        assert!(
            recovery_charge > 0,
            "only the excess above the prior peak is taxable"
        );
    }

    #[test]
    fn high_water_mark_resets_after_a_full_exit() {
        let mut snap = fresh();
        let baseline_hwm = snap.high_water_mark;

        deposit(&mut snap, 1_000_000, 0).unwrap();
        report_gain(&mut snap, 500_000).unwrap();
        accrue_performance_fee(&mut snap, 2_000).unwrap();
        assert!(snap.high_water_mark > baseline_hwm);

        redeem_all(&mut snap).unwrap();
        assert_eq!(snap.total_shares, 0);
        assert_eq!(
            snap.high_water_mark, baseline_hwm,
            "no shares outstanding means no prior gain left to protect"
        );

        // A fresh depositor generation isn't held to the old, unrelated peak.
        deposit_next(&mut snap, 1_000_000).unwrap();
        report_gain(&mut snap, 500_000).unwrap();
        assert!(accrue_performance_fee(&mut snap, 2_000).unwrap() > 0);
    }

    // ── management fee ───────────────────────────────────────────────────────

    #[test]
    fn management_fee_accrues_pro_rata_over_elapsed_time() {
        let mut snap = fresh();
        deposit(&mut snap, 1_000_000, 0).unwrap();
        // 10% annual, over exactly half a year.
        let fee = accrue_management_fee(&mut snap, SECONDS_PER_YEAR as u64 / 2, 1_000).unwrap();
        assert_eq!(fee, 50_000);
        assert_eq!(snap.accrued_fees, 50_000);
    }

    #[test]
    fn management_fee_at_zero_elapsed_or_zero_rate_is_a_no_op_amount() {
        let mut snap = fresh();
        deposit(&mut snap, 1_000_000, 0).unwrap();
        assert_eq!(accrue_management_fee(&mut snap, 0, 1_000).unwrap(), 0);
        assert_eq!(accrue_management_fee(&mut snap, 1_000, 0).unwrap(), 0);
    }

    #[test]
    fn management_fee_checkpoint_advances_even_at_zero_rate() {
        let mut snap = fresh();
        accrue_management_fee(&mut snap, 1_000, 0).unwrap();
        assert_eq!(snap.last_fee_time, 1_000);
    }

    #[test]
    fn management_fee_rejects_a_checkpoint_older_than_the_last_one() {
        let mut snap = fresh();
        accrue_management_fee(&mut snap, 1_000, 500).unwrap();
        assert_eq!(
            accrue_management_fee(&mut snap, 999, 500),
            Err(Error::StaleSnapshot)
        );
    }

    // ── loss cannot eat pending withdrawals or fees ─────────────────────────

    #[test]
    fn loss_cannot_exceed_assets_backing_outstanding_shares() {
        let mut snap = fresh();
        deposit(&mut snap, 1_000, 0).unwrap();
        let half_shares = snap.total_shares / 2;
        let version = snap.version;
        request_withdrawal(&mut snap, half_shares, version).unwrap();
        let backing = net_assets(&snap).unwrap();
        assert_eq!(
            report_loss(&mut snap, backing + 1),
            Err(Error::InsufficientBalance)
        );
        report_loss(&mut snap, backing).unwrap();
        assert_eq!(net_assets(&snap).unwrap(), 0);
        assert!(snap.pending_withdrawals > 0, "queued withdrawal untouched");
    }

    // ── partial withdrawal queue ─────────────────────────────────────────────

    #[test]
    fn withdrawal_queue_fulfills_across_several_partial_payments() {
        let mut snap = fresh();
        deposit(&mut snap, 1_000, 0).unwrap();
        let mut request = redeem_all(&mut snap).unwrap();
        assert_eq!(request.assets_owed, 1_000);

        assert_eq!(
            fulfill_withdrawal(&mut snap, &mut request, 400).unwrap(),
            400
        );
        assert_eq!(request.assets_paid, 400);
        assert_eq!(snap.pending_withdrawals, 600);

        assert_eq!(
            fulfill_withdrawal(&mut snap, &mut request, 600).unwrap(),
            600
        );
        assert_eq!(request.assets_paid, 1_000);
        assert_eq!(snap.pending_withdrawals, 0);

        assert_eq!(
            fulfill_withdrawal(&mut snap, &mut request, 1),
            Err(Error::WithdrawalAlreadySettled)
        );
    }

    #[test]
    fn fulfill_withdrawal_rejects_amount_beyond_what_is_owed() {
        let mut snap = fresh();
        deposit(&mut snap, 1_000, 0).unwrap();
        let mut request = redeem_all(&mut snap).unwrap();
        let too_much = request.assets_owed + 1;
        assert_eq!(
            fulfill_withdrawal(&mut snap, &mut request, too_much),
            Err(Error::ExceedsOwed)
        );
    }

    #[test]
    fn fulfill_withdrawal_rejects_amount_beyond_vault_liquidity() {
        let mut snap = fresh();
        deposit(&mut snap, 1_000, 0).unwrap();
        let mut request = redeem_all(&mut snap).unwrap();
        snap.total_assets = 10; // simulate assets not actually on hand yet
        assert_eq!(
            fulfill_withdrawal(&mut snap, &mut request, 500),
            Err(Error::InsufficientBalance)
        );
    }

    // ── fee claim ────────────────────────────────────────────────────────────

    #[test]
    fn claim_fees_cannot_exceed_accrued_amount() {
        let mut snap = fresh();
        deposit(&mut snap, 1_000_000, 0).unwrap();
        report_gain(&mut snap, 500_000).unwrap();
        accrue_performance_fee(&mut snap, 2_000).unwrap();
        let accrued = snap.accrued_fees;

        assert_eq!(
            claim_fees(&mut snap, accrued + 1),
            Err(Error::InsufficientBalance)
        );
        claim_fees(&mut snap, accrued).unwrap();
        assert_eq!(snap.accrued_fees, 0);
    }

    // ── overflow safety ──────────────────────────────────────────────────────

    #[test]
    fn extreme_values_fail_cleanly_instead_of_panicking() {
        let snap = VaultSnapshot {
            total_shares: i128::MAX / 2,
            total_assets: i128::MAX / 2,
            ..fresh()
        };
        assert_eq!(
            preview_deposit(&snap, i128::MAX / 2),
            Err(Error::MathOverflow)
        );
    }

    // ── property-based conservation tests ───────────────────────────────────

    use proptest::prelude::*;

    proptest! {
        #[test]
        fn prop_deposits_alone_conserve_value_exactly_and_never_decrease_price(
            amounts in prop::collection::vec(1i128..1_000_000_000i128, 1..15)
        ) {
            let mut snap = fresh();
            let mut total_deposited: i128 = 0;
            let mut last_price = price_per_share(&snap).unwrap();

            for amount in amounts {
                let version = snap.version;
                if deposit(&mut snap, amount, version).is_ok() {
                    total_deposited += amount;
                    prop_assert_eq!(snap.total_assets, total_deposited);
                    let price = price_per_share(&snap).unwrap();
                    prop_assert!(price >= last_price);
                    last_price = price;
                }
            }
        }

        #[test]
        fn prop_deposit_then_full_redeem_never_pays_out_more_than_was_put_in(
            assets in 1i128..1_000_000_000i128
        ) {
            let mut snap = fresh();
            deposit(&mut snap, assets, 0).unwrap();
            let request = redeem_all(&mut snap).unwrap();
            prop_assert!(request.assets_owed <= assets);
        }

        #[test]
        fn prop_preview_matches_execute_for_deposit_and_redeem(
            first in 1i128..1_000_000_000i128,
            second in 1i128..1_000_000_000i128,
        ) {
            let mut snap = fresh();
            deposit(&mut snap, first, 0).unwrap();

            if let Ok(previewed) = preview_deposit(&snap, second) {
                let version = snap.version;
                let executed = deposit(&mut snap, second, version).unwrap();
                prop_assert_eq!(previewed, executed.shares_minted);
            }
        }

        #[test]
        fn prop_conservation_holds_across_deposit_withdraw_fulfill_sequences(
            ops in prop::collection::vec((0u8..3, 1i128..1_000_000i128), 1..20)
        ) {
            let mut snap = fresh();
            let mut total_deposited: i128 = 0;
            let mut total_paid_out: i128 = 0;
            let mut open_requests: std::vec::Vec<WithdrawalRequest> = std::vec::Vec::new();

            for (kind, amount) in ops {
                match kind {
                    0 => {
                        let version = snap.version;
                        if deposit(&mut snap, amount, version).is_ok() {
                            total_deposited += amount;
                        }
                    }
                    1 => {
                        let share_amount = amount.min(snap.total_shares);
                        let version = snap.version;
                        if share_amount > 0 {
                            if let Ok(request) = request_withdrawal(&mut snap, share_amount, version) {
                                open_requests.push(request);
                            }
                        }
                    }
                    _ => {
                        if let Some(request) = open_requests.first_mut() {
                            let remaining = request.assets_owed - request.assets_paid;
                            let pay = amount.min(remaining).min(snap.total_assets);
                            if pay > 0 && fulfill_withdrawal(&mut snap, request, pay).is_ok() {
                                total_paid_out += pay;
                            }
                            if request.assets_paid >= request.assets_owed {
                                open_requests.remove(0);
                            }
                        }
                    }
                }

                prop_assert_eq!(total_deposited, snap.total_assets + snap.dust + total_paid_out);
                prop_assert!(snap.total_assets >= snap.pending_withdrawals + snap.accrued_fees);
            }
        }

        #[test]
        fn prop_high_water_mark_never_decreases_while_shares_remain_outstanding(
            ops in prop::collection::vec((0u8..2, 1i128..500_000i128), 1..20)
        ) {
            let mut snap = fresh();
            deposit(&mut snap, 10_000_000, 0).unwrap();
            let mut last_hwm = snap.high_water_mark;

            for (kind, amount) in ops {
                match kind {
                    0 => { let _ = report_gain(&mut snap, amount); }
                    _ => {
                        let cap = net_assets(&snap).unwrap_or(0);
                        let loss = amount.min(cap.max(0));
                        if loss > 0 {
                            let _ = report_loss(&mut snap, loss);
                        }
                    }
                }
                let _ = accrue_performance_fee(&mut snap, 1_000);
                prop_assert!(snap.high_water_mark >= last_hwm);
                last_hwm = snap.high_water_mark;
            }
        }
    }
}
