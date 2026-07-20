# Pull Request 1: Issue #16

## PR Title
test(contracts): fix #16 add contract tests for multi-round lockup rollover

## Commit Message
test(contracts): fix #16 add contract tests for multi-round lockup rollover

## PR Description
This Pull Request resolves issue **#16** by adding regression test coverage and clarifying duration lockup rollover semantics for Soroban smart contracts when a participant makes repeated deposits with different lockup durations.

### Problem
Contract coverage previously verified single deposit lockup and withdrawal rules, but multi-round lockup rollover and repeated deposit paths with mixed duration tiers were missing automated regression coverage.

### Flow & Implementation Details
- **Lockup Extension & Protection**: In `contracts/drip-pool/src/lib.rs` and `contracts/drip-pool/src/vault.rs`, `deposit_with_duration` updates `locked_until = max(existing_locked_until, current_ledger + new_duration_ledgers)`. Making a flexible deposit (0-day duration) or shorter deposit during an active long lockup (90-day duration) will **never shorten or bypass** the active lockup window.
- **Yield Multipliers**: Multipliers update to the selected duration tier (`100` for flexible, `110` for short 7-day, `125` for medium 14-day, `150` for long 90-day). Upon sequence completion, `withdraw` computes yield-adjusted payout `(deposited * multiplier) / 100`. Early withdrawals revert with `Error::LockupActive`.

### Why it Matters
Eliminates lockup circumvention vulnerabilities during repeated deposits and ensures users receive accurate time-weighted APY boosts.

## Changed
- Exposed `deposit_with_duration` and lockup helpers in `contracts/drip-pool/src/lib.rs` and `contracts/drip-pool/src/vault.rs` (#16).
- Added unit tests `test_multi_round_lockup_rollover_mixed_durations`, `test_deposit_flexible_during_active_lockup_preserves_lockup`, and `test_deposit_after_lockup_expiration_resets_lockup_window` in `contracts/drip-pool/src/test.rs` (#16).
- Updated lockup rollover test status in `docs/TEST_COVERAGE_MAP.md` (#16).

## Testing
```bash
cargo test --manifest-path contracts/drip-pool/Cargo.toml
```
*Result*: All 48 tests passed (0 failures, 0 warnings).

## Scope Notes
- Smart contract layer only (`contracts/drip-pool/`). No frontend or indexer database schema changes.

## Push Command
```bash
git push -u origin fix/issue-16-contract-lockup-rollover-tests
```

---

# Pull Request 2: Issue #8

## PR Title
feat(dashboard): fix #8 replace vault leaderboard placeholder with indexed data

## Commit Message
feat(dashboard): fix #8 replace vault leaderboard placeholder with indexed data

## PR Description
This Pull Request resolves issue **#8** by replacing the placeholder leaderboard component with a production-grade, indexed saver leaderboard integration.

### Problem
`components/app/VaultLeaderboardPlaceholder.jsx` rendered static mockup data, creating an unfinished product surface for users comparing pool saver rankings.

### Flow & Implementation Details
- **Data Contracts**: Defined TypeScript domain models in `types/leaderboard.ts` (`LeaderboardEntry`, `LeaderboardFilterOptions`, `LeaderboardResponse`, `RankState`).
- **Data Orchestration Service**: Created `services/leaderboardService.ts` providing API data fetching, deterministic sorting (`sortLeaderboardEntries`), dev mode fallback, and privacy-conscious address formatting (`formatPrivacyAddress` for Stellar `GABC...XYZ` & EVM `0x12...5678`).
- **Backend API Route**: Added `/actions/leaderboard` endpoint in `backend/src/routes/actions.ts`.
- **Full UI State Lifecycle**: Replaced static placeholder with `VaultLeaderboard` component in `components/app/VaultLeaderboardPlaceholder.jsx`, supporting skeleton loading, error retry, empty states, and rank badges (#1 gold, #2 silver, #3 bronze).

### Why it Matters
Provides transparent, privacy-conscious saver analytics driven by indexed transaction data, boosting dApp engagement and user retention.

## Changed
- Created `types/leaderboard.ts` with TypeScript data contracts (#8).
- Created `services/leaderboardService.ts` with API data fetching, sorting, fallback logic, and privacy address formatting (#8).
- Added `/actions/leaderboard` route in `backend/src/routes/actions.ts` (#8).
- Replaced placeholder component in `components/app/VaultLeaderboardPlaceholder.jsx` with indexed `VaultLeaderboard` supporting loading, error, empty, and populated states (#8).
- Created component unit tests in `components/app/VaultLeaderboard.test.jsx` (#8).

## Testing
```bash
npx vitest run components/app/VaultLeaderboard.test.jsx
```
*Result*: All sorting, address formatting, and UI state tests passed.

## Scope Notes
- Frontend UI and backend API layer. Excludes smart contract changes.

## Push Command
```bash
git push -u origin fix/issue-8-vault-leaderboard-indexed-data
```
