# Indexer Operations Runbook

This document details the operational procedures, metrics, alarm thresholds, and manual recovery steps for the VaultQuest Event Indexer.

---


## Startup configuration validation (issue #133)

Before the indexer worker starts, the backend:

1. StrKey-decodes every entry in `INDEXER_CONTRACT_IDS` as a contract (`C…`) ID — rejecting malformed values, account (`G…`) keys, duplicates, and whitespace-only lists.
2. Requires `SOROBAN_NETWORK_PASSPHRASE` and calls Soroban RPC `getNetwork` against `SOROBAN_RPC_URL`.
3. Refuses to start (process exit) when the RPC passphrase does not match, or when contract IDs are invalid.

The configured passphrase must match the RPC's full passphrase exactly. Leading
or trailing whitespace is part of the network identity and is not trimmed for
comparison. Empty or whitespace-only configuration still fails before the RPC
probe. Whitespace around comma-separated contract IDs continues to be ignored.

`GET /health/indexer` includes the validated set:

```json
{
  "configured": true,
  "contract_ids": ["C…"],
  "network": {
    "passphrase": "Test SDF Network ; September 2015",
    "protocol_version": "21"
  }
}
```

When the indexer is not configured, `configured` is `false` and `network` is `null`.


### Canonical install and focused acceptance

Use the integrity-pinned pnpm version in the root package manifest:

```bash
pnpm install --frozen-lockfile --reporter=append-only
pnpm --dir backend exec vitest run tests/indexerConfig.spec.ts
```

The workspace and root lock now reuse the dependency repair from
[PR214 source `08915ce6`](https://github.com/woahwhattheheck/vaultquest/commit/08915ce6cf89fcbc238319599d77ff41ff30bc7b).
All three workspace manifests matched that source exactly. The lock includes the
backend's already-declared SendGrid and Stellar SDK dependencies; compatible
Vitest 3.2.x and Vite 6.4.x overrides replace the unbounded runner overrides.
The scoped Solana WebSocket provider and all other overrides/build permissions
are preserved from that repair. No indexer implementation or tests changed.

On 2026-10-04, [native run 37200230710](https://github.com/woahwhattheheck/vaultquest/actions/runs/37200230710/job/111430233741)
checked product `9c8a809f8b91ea66d1a3370cc562003bc036d9e8` on Ubuntu 24.04,
Node 22.23.3 and pnpm 10.28.2. The normal frozen install completed across all
three workspaces in 16.2 seconds. The unchanged indexer file passed **16/16**
cases on Vitest 3.2.7 in 600 ms (16 ms in assertions). Dependency files remained
unchanged by installation and execution.

Raw install output and JSON results are in artifact `11302787703`,
SHA-256 `6f815b995792bbf98dc9fb06049eb18f1bf2cc5b598a05852b0922b6da8e9a8c`.
The first validation controller stopped before installation because it redundantly
specified the package-manager version; the successful controller
`5d42e1f6a3696a443f6d6d532b6a67b382a54e1d` uses the manifest's integrity-pinned version.
Both controllers used the same product source. This result covers installation
and configuration validation; full backend build, Prisma generation, database
startup and live RPC execution were not run.

## 1. System Overview

The backend constructs a `StellarIndexer` worker after configuration validation.
The current `SorobanRpcEventSource.fetchEvents` implementation returns an empty
array: live Soroban event retrieval is still a placeholder. A valid configuration,
a running cron job or the `configured` health field does not establish that live
events are being ingested.

When supplied with an event source, the in-process worker reconciles decoded
events directly through `LedgerService`. It saves both the last event ID and its
ledger number through that service. External indexers can use the protected
`POST /internal/reconcile` endpoint and report their checkpoint through:

* **Endpoint:** `POST /internal/checkpoint`
* **Authorization:** `X-Internal-Secret` header containing the backend's configured `INTERNAL_SERVICE_SECRET`.

The backend stores this in the `indexer_checkpoints` database table. A public health interface is available at `GET /health/indexer` to calculate sync lag dynamically.

---

## 2. Sync Lag Metrics & Alerts

Sync lag is calculated dynamically by checking the last successful sync time and comparing the current ledger sequence with the indexer's processed sequence.

### Health Status Definitions

| Status | Threshold / Condition | User & Ops Impact | Action Required |
|---|---|---|---|
| **Healthy** | Success sync < 5m ago, zero errors. | Real-time txn updates. | None. Normal operation. |
| **Lagging** | Last successful sync > 5m ago, but no reported hard errors. | Updates delayed by a few minutes. | Low priority. Monitor. |
| **Degraded** | Hard error reported (`last_error` is not null) or sync lag exceeds critical limits. | User-facing deposits/claims block. | Immediate investigation required. |

### Alarm Thresholds

* **Warning (Soft Lag):** Sync lag sequence > 100 ledgers (~8.3 minutes on Stellar).
* **Critical (Hard Lag):** Sync lag sequence > 500 ledgers (~41.6 minutes) OR `status == "degraded"` (persistent error reported).

---

## 3. Troubleshooting & Recovery Procedures

If the indexer reports a `lagging` or `degraded` state, follow these diagnostic steps sequentially:

### Step A: Inspect the Indexer Health Status
Run a query against the health endpoint to gather current statistics:
```bash
curl -X GET https://api.vaultquest.io/health/indexer
```
Example Degraded Output:
```json
{
  "data": {
    "status": "degraded",
    "latest_ledger": 1492023,
    "last_sync_time": "2026-05-30T03:00:00.000Z",
    "last_success_sync_time": "2026-05-30T02:45:00.000Z",
    "last_error": "Horizon RPC rate limit exceeded (HTTP 429)",
    "sync_lag": 180,
    "message": "Indexer reported error: Horizon RPC rate limit exceeded (HTTP 429)"
  }
}
```

### Step B: Common Failure Modes & Solutions

#### 1. Horizon RPC Rate Limiting (429)
* **Diagnosis:** `last_error` contains `rate limit` or `429`.
* **Resolution:** 
  1. Inspect the Horizon API keys or RPC endpoint settings in the indexer environment (`.env`).
  2. If using a public RPC node, switch to a dedicated premium node provider.
  3. Adjust the indexer polling delay configuration to reduce request frequencies.

#### 2. Re-entrancy or Out-of-Sequence Event Parse Failures
* **Diagnosis:** Indexer fails repeatedly on a specific ledger block due to bad payload serialization.
* **Resolution:**
  1. Note the ledger number (`latest_ledger`) where the indexer is stuck.
  2. Inspect the indexer container logs for parsing errors.
  3. Review the checkpoint recovery limits below before planning a replay. Changing `latest_ledger` alone does not reset the event cursor.

#### 3. Database Connection Pool Exhaustion
* **Diagnosis:** Indexer logs show `PrismaClientInitializationError: Can't reach database`.
* **Resolution:**
  1. Check database server load and active connection count.
  2. Increase connection pool size parameters in `DATABASE_URL` (e.g., `&connection_limit=20`).
  3. Restart the backend Fastify server to clear stale connections.

---

## 4. Operational Commands (Manual Interventions)

### View Current Checkpoint in Database
Connect to the database via `psql` or Prisma Studio and query the database directly:
```sql
SELECT * FROM indexer_checkpoints WHERE id = 'singleton';
```

### Replay and checkpoint recovery limits

The worker resumes from `last_processed_event_id`, which it passes to the event
source as its cursor. `latest_ledger` records the corresponding ledger number;
changing that number alone does not rewind the cursor or select the next ledger.
There is no supported ledger-only rewind command in this package.

Checkpoint reads prefer Redis `indexer:checkpoint` when available and fall back
to the PostgreSQL `singleton` row. The backend also flushes a dirty cached
checkpoint to PostgreSQL every 15 seconds. A database-only edit can therefore be
ignored at restart or overwritten by the cached checkpoint.

Before planning a deployment-specific replay, stop every backend/indexer instance
and any external checkpoint writer, and preserve both the database row and the
cached checkpoint, including their event IDs and timestamps. A replay procedure
must define a valid cursor for the deployed event source and reconcile both
checkpoint stores before writers restart. The current placeholder event source
does not retrieve historical events, so editing its checkpoint cannot restore
missing events. This runbook does not supply an unimplemented reset operation.

Keep `last_success_sync_time` tied to actual successful processing. Setting it to
`NOW()` during a manual checkpoint edit would report fresh success without a
successful sync. Confirm recovery using observed event processing and resulting
ledger records, rather than a changed timestamp alone.

Source references: [worker cursor and event source](../backend/src/services/stellarIndexer.ts),
[checkpoint read/write behavior](../backend/src/services/cacheService.ts), and
[backend checkpoint flush](../backend/src/server.ts).

---

## 5. Security & Access Control

* The `/internal/checkpoint` and `/internal/reconcile` routes MUST always be guarded by a secure service auth key.
* Configure `INTERNAL_SERVICE_SECRET` in the backend environment before starting
  the server. Normal environment validation requires at least 20 characters and
  rejects placeholder values. Replace the checked-in example with a secret
  supplied by your deployment's secret configuration.
* For internal HTTP calls to either route, send that same value in the
  `X-Internal-Secret` header. The shared guard rejects requests without a matching
  secret. Never expose this key in client-side bundles.
* When rotating the secret, restart the backend with the updated configuration
  and update internal HTTP callers to use the same value. The server passes the
  configured value into the route guards when it builds the application.

The [environment schema](../backend/src/env.ts),
[server startup](../backend/src/server.ts), and
[shared header verifier](../backend/src/middleware/internal-secret.ts) define
these configuration and header names.
