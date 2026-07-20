# VaultQuest Issues Implementation Document (#16 & #8)

This document presents the full technical implementation for the two assigned open-source issues in VaultQuest.

---

## 1. Contract Tests for Multi-Round Lockup Rollover & Repeated Deposits (#16)

### Issue Summary & Problem Statement
Contract coverage previously verified single deposit lockup and withdrawal rules, but lacked regression coverage for multi-round lockup rollover when a participant makes repeated deposits with different duration tiers (flexible, short, medium, long).

### Key Architectural Decisions
- **Lockup Expiration Safety**: When a participant deposits additional funds while an active lockup exists, `locked_until` is updated to `max(existing_locked_until, current_ledger + duration_ledgers)`. This ensures that depositing flexible funds (0 days duration) during an active long lockup (90 days duration) will **never shorten or bypass** the existing active lockup window.
- **Yield Boost Multipliers**: Multipliers are updated to match the latest selected lockup tier (`100` for flexible, `110` for short 7-day, `125` for medium 14-day, `150` for long 90-day). Upon lockup completion, withdrawal computes yield-adjusted payout `(deposited * multiplier) / 100`.

### Smart Contract Implementation Details
In `contracts/drip-pool/src/lib.rs` and `contracts/drip-pool/src/vault.rs`:
- Exposed `deposit_with_duration(env, who, amount, lockup_days)` on `DripPool`.
- Made multiplier and lockup ledger helpers `pub(crate)` in `vault.rs`.
- Enforced lockup extension logic `if new_locked_until > p.locked_until { p.locked_until = new_locked_until; }`.

### Added Rust Unit Tests (`contracts/drip-pool/src/test.rs`)
1. **`test_multi_round_lockup_rollover_mixed_durations`**:
   - Depositor deposits with 7-day short duration (`multiplier = 110`).
   - Before expiration, depositor adds deposit with 90-day long duration (`multiplier = 150`).
   - Asserts `locked_until` is extended.
   - Verifies early withdrawal attempt reverts with `Error::LockupActive`.
   - Advances ledger sequence past long lockup expiration and verifies withdrawal returns 1.5x yield payout.

2. **`test_deposit_flexible_during_active_lockup_preserves_lockup`**:
   - Depositor deposits with 14-day medium duration (`locked_until` set).
   - Depositor adds flexible (0-day) deposit.
   - Asserts `locked_until` is preserved and NOT reset to current ledger sequence.
   - Verifies early withdrawal remains blocked until medium lockup sequence passes.

3. **`test_deposit_after_lockup_expiration_resets_lockup_window`**:
   - Depositor completes short lockup cycle.
   - Advances past expiration sequence.
   - Depositor makes a subsequent long deposit.
   - Asserts new lockup window is set cleanly from the current sequence.

---

## 2. Real Indexed Vault Leaderboard & Component Refactoring (#8)

### Issue Summary & Problem Statement
Replaced the static placeholder component `components/app/VaultLeaderboardPlaceholder.jsx` with a production-grade, indexed leaderboard component, backend endpoint, and typed data service.

### Key Architectural Decisions
- **Data Model & Type Safety (`types/leaderboard.ts`)**: Defined `LeaderboardEntry`, `LeaderboardFilterOptions`, `LeaderboardResponse`, and `RankState` ("rising" | "holding" | "new").
- **Privacy-Conscious Formatting (`services/leaderboardService.ts`)**: `formatPrivacyAddress(address)` formats Stellar public keys (`GABC...XYZ`) and EVM addresses (`0x1234...5678`) to protect user identity on public leaderboards.
- **Deterministic Sorting & Local Dev Fallback**: `sortLeaderboardEntries` ranks entries by `score` descending, then `depositedAmount` descending, then `ticketsCount` descending. Falls back to deterministic mock data when live backend indexing is offline in local dev environments.
- **Backend Indexing Route (`backend/src/routes/actions.ts`)**: Added `GET /actions/leaderboard` route serving indexed saver metrics from action ledger data.
- **Full UI State Lifecycle (`components/app/VaultLeaderboardPlaceholder.jsx`)**:
  - **Loading**: Skeleton animation matching app design.
  - **Error**: User-friendly message with Retry action.
  - **Empty**: Accessible empty state for vaults with no activity yet.
  - **Populated**: High-contrast rank badges (#1 gold, #2 silver, #3 bronze highlights), tickets count, score, and state badges.

### Added Component & Service Unit Tests (`components/app/VaultLeaderboard.test.jsx`)
- Verified privacy address formatting logic (`formatPrivacyAddress`).
- Verified sorting order (`sortLeaderboardEntries`).
- Tested populated, loading, error/retry, and empty UI state rendering with Vitest & React Testing Library.
