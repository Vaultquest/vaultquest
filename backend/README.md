# VaultQuest Backend

Action ledger and reconciliation service for TrustQuest (issue #34).

## Stack

- Node 20 + TypeScript
- Fastify 4 (HTTP)
- Prisma 5 + Postgres 16 (storage)
- Zod (validation)
- Pino (logging)
- node-cron (orphan sweep)
- Vitest + Testcontainers (tests against real Postgres)

## Setup

```bash
cp .env.example .env
pnpm install
# Setup database (migrations and mock seed data)
pnpm run db:setup
pnpm test
pnpm dev
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET  | /health | Liveness probe |
| POST | /actions | Create intent (requires `Idempotency-Key: <uuid>`) |
| PATCH | /actions/:id/submitted | Attach `tx_hash` after wallet broadcasts |
| POST | /actions/:id/cancel | Mark a pending intent failed |
| GET  | /actions/:id | Read a single action |
| GET  | /actions?wallet=G...&status=&cursor=&limit= | Paginated activity history |
| GET  | /dashboard/summary?wallet=G...&stale_after_ms= | Per-wallet rollup for the dashboard (#14) |
| GET  | /saved-pools?wallet=G... | Saved-pools watchlist entries |
| POST | /saved-pools | Save or update a pool watchlist entry |
| DELETE | /saved-pools/:poolId?wallet=G... | Remove a saved pool from a wallet watchlist |
| DELETE | /actions?wallet=G... | Privacy scrub (nulls payload, sets redacted_at) |
| POST | /internal/reconcile | Event indexer → ledger (requires `X-Internal-Secret`) |

See `docs/superpowers/specs/2026-04-23-action-ledger-design.md` for the full contract, and [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the service layout, schema, worker runtime, and migration strategy. For response envelopes, errors, and pagination, see [`docs/API_RESPONSES.md`](./docs/API_RESPONSES.md). For how the frontend should submit, poll, and **retry** these endpoints safely, see [`docs/transaction-status-api.md`](./docs/transaction-status-api.md). Indexer contributors should also follow the contract [`event schema`](../contracts/docs/EVENT_SCHEMA.md) and [`pause/recovery model`](../contracts/docs/PAUSE_RECOVERY.md).

## Environment

See `.env.example`. All values are validated at boot via Zod.

## Tests

Tests use Testcontainers to spin up Postgres 16 per run. Docker must be available.

```bash
pnpm test
```

### Scheduled job ownership

Scheduled reconciler, quest, indexer, backup, and restore work uses the
`job_leases` table. Acquisition and renewal use PostgreSQL's clock; sharing an
owner ID does not allow a second process to replace a live worker.

The callback receives a `JobLeaseContext`. Database changes must run through
`lease.transaction(tx => ...)` and use that transaction's Prisma client. The
lease row stays locked while the operation runs, and owner, fence token,
expiry, and cancellation are checked again before commit. Reconciler batches,
individual wallet quest updates, indexer events, and checkpoints use this path.
Checkpoints are committed directly to PostgreSQL; a delayed Redis write cannot
overwrite a replacement worker's progress.

Long backup preparation runs outside the short database transaction with an
`AbortSignal` and a unique owner/fence path. Completed dumps are promoted from
`.partial` files by atomic rename. Manifest publication and pruning use
`lease.withFence(...)`. Restore drills use isolated database names; the default
runner needs `createdb` and `dropdb` alongside `pg_restore` and permission to
create a database. Injected filesystem adapters need atomic `rename` for leased
backups. Storage and restore adapters should honor the supplied signal. A
remote request already accepted by a storage provider cannot be rolled back by
a PostgreSQL transaction; stronger remote guarantees require native provider
fencing. Cancelled preparation can leave an unreferenced partial artifact or an
isolated restore database for cleanup.

Focused ownership checks:

```bash
pnpm exec vitest run tests/jobLease.spec.ts tests/jobLease.postgres.spec.ts tests/backup.spec.ts tests/retry.spec.ts
```

`jobLease.postgres.spec.ts` checks real domain writes and rollback, plus a
separate-connection PostgreSQL lock-contention case. When Docker is unavailable,
`VAULTQUEST_TEST_DATABASE_URL` may point at a dedicated disposable PostgreSQL
database; the test helper synchronizes and clears its schema. Run with one
Vitest worker when sharing that database. A single-session compatibility engine
must set `VAULTQUEST_TEST_SINGLE_SESSION=1`; this explicitly skips the native
connection-contention case and does not establish that guarantee.
