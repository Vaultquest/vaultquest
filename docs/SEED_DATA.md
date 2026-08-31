# Local Seed Data

VaultQuest ships two complementary layers of local seed data so that the app,
the backend, and the test suite all exercise a realistic set of states without
touching a live chain.

## 1. Frontend mock catalog (`lib/vault-mock-data.js`)

`MOCK_VAULTS` is the vault catalog served by `GET /api/vaults` and consumed by
the dashboard, vault list, vault detail, and archive pages. It drives the UI
until live indexer data is wired in.

Every vault exposes the fields the UI actually reads — including `minDeposit`
and `totalDeposits`, which `useVaultDataReview` treats as required — and the
catalog collectively spans every round lifecycle state:

| Round status | Count | Meaning |
|---|---|---|
| `active` | 3 | Round is accepting deposits / drawing |
| `pending` | 2 | Round announced, not yet open |
| `paused` | 1 | Round frozen (no new yield/deposits) |
| `completed` | 1 | Round finished, payouts settled |
| `failed` | 1 | Round failed, deposits returned, closed |

`VAULT_ROUND_ARCHIVE` lists historical rounds; each entry references a vault
that still exists in `MOCK_VAULTS` so archive cards can deep-link to the detail
page. Archive aggregates (participants, deposits, prize payouts, winners) are
kept coherent under `lib/vault-mock-data.test.js`.

`lib/demo-portfolio.js` holds `DEMO_TRANSACTIONS` (a connected wallet's local
activity history: deposits, prize draws/rewards, withdrawals, plus a `failed`
entry) and `PUBLIC_STATS`/`DEMO_PORTFOLIO` summary metrics. The summarizer
excludes `failed`/`reverted` transactions from balances.

## 2. Backend action-ledger seed (`backend/prisma/seed.ts`)

`pnpm db:setup` (or `pnpm --filter backend run db:setup`) runs migrations and
then the Prisma seed, which populates:

- `IndexerCheckpoint` — the singleton cursor row.
- `SavedPool` — watchlist entries for the three demo wallets, using only the
  contract's `savedPoolStatus` enum (`open | locked | drawing | settled`).
- `PendingEvent` — sample indexer events.
- `ActionLedger` — deposits, withdrawals, `claim` (rewards), and `select_winner`
  (draws) across the wallets, spanning every `ActionStatus`
  (`pending`, `submitted`, `confirmed`, `failed`, `reverted`, `orphaned`).

The core logic lives in `backend/prisma/seed-lib.ts` (`seedDatabase`), which is
also imported by `backend/tests/seed-lib.spec.ts` so idempotency is verified in
CI against a real Postgres container.

## Idempotency

The backend seed is **idempotent by construction**:

1. It resets the four seeded tables (`deleteMany`) before recreating.
2. Every `idempotencyKey` is a **deterministic** v5-style UUID
   (`deterministicUuid(label)` in `seed-lib.ts`), so the same logical action
   always maps to the same key — no fresh random keys on each run.
3. Timestamps derive from a fixed `now` (default `Date.now()`) that can be
   injected for reproducible runs.

`backend/tests/seed-lib.spec.ts` asserts that re-running `seedDatabase` with the
same fixed timestamp yields byte-for-byte identical rows and raises no
unique-key conflicts.

## Testing the seed

```bash
# Frontend catalog/contract tests (no DB required)
pnpm test lib/vault-mock-data.test.js lib/demo-portfolio.test.js

# Backend seed idempotency + status contract tests (requires Docker)
pnpm --filter backend run test -- seed-lib.spec.ts
```

Frontend contract coverage lives in `lib/vault-mock-data.test.js` and
`lib/demo-portfolio.test.js`; see [TESTING.md](./TESTING.md) for the overall
test matrix.
