# Admin operational health remediation

Runbook for alerts shown on the VaultQuest admin settings console
(`/app/admin/settings`). Live checks are evaluated by
`lib/deployment-provenance.ts` and served from `GET /api/admin/health`.

Related: [`INDEXER_RUNBOOK.md`](./INDEXER_RUNBOOK.md),
[`env-inventory.md`](./env-inventory.md).

---

## Health states

| State | Meaning | Typical cause | Operator action |
|---|---|---|---|
| **Healthy** | Within thresholds | Normal | Continue routine monitoring |
| **Stale** | Soft lag / elevated latency | Indexer behind &lt; hard limit, slow RPC | Monitor; escalate if sustained &gt; 10 minutes |
| **Degraded** | Hard failure or critical drift | RPC down, indexer error, WASM mismatch, critical config drift | Intervene immediately |

---

## 1. RPC health

### Symptoms
- **Stale:** Horizon/Soroban latency ≥ 1500ms.
- **Degraded:** unreachable, HTTP 5xx, timeout, or network passphrase mismatch.

### Diagnose
```bash
curl -s https://horizon-testnet.stellar.org | jq '{network_passphrase, horizon_version}'
curl -s -X POST https://soroban-testnet.stellar.org \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
```

### Remediate
1. The probe checks both Horizon root and Soroban `getHealth` / `getNetwork` for the intended passphrase. Confirm `NEXT_PUBLIC_HORIZON_URL` / `NEXT_PUBLIC_SOROBAN_RPC_URL` point at the intended network (see `env-inventory.md`).
2. If rate-limited (HTTP 429), switch to a dedicated RPC provider or raise poll interval.
3. If passphrase mismatches, stop using the endpoint — it is the wrong network.

---

## 2. Contract WASM provenance

### Symptoms
- **Degraded:** the on-chain contract instance WASM hash differs from `EXPECTED_CONTRACT_WASM_HASH`.
- Missing or invalid expected release hash, invalid contract ID, missing instance, or failed RPC lookup is also degraded.

### Diagnose
1. Compare the admin panel “Smart contract WASM hash” metadata (`expectedHash` vs `actualHash`).
2. Confirm the drip-pool contract id in `NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID`.
3. The admin probe reads the contract instance through Soroban `getLedgerEntries` and decodes its executable hash. Re-derive the expected release WASM hash from the tagged build artifact.

### Remediate
1. If an approved upgrade completed, update `EXPECTED_CONTRACT_WASM_HASH` to the new release hash and redeploy the frontend. Never copy the observed hash into the expected setting before verifying the release.
2. If the on-chain hash changed without a governance proposal, pause admin writes and open an incident — treat as possible substitution.
3. Cross-check proxy `last_provenance` on-chain against the published release notes.

---

## 3. Configuration drift

### Symptoms
- **Stale:** non-critical parameters (round duration, deposit caps) differ from canonical provenance.
- **Degraded:** critical parameters (`treasuryFee`, `settlementQuorum`, `emergencyPauseThreshold`) or `contractId` differ, or the independent observation is missing, incomplete, or older than five minutes.

### Diagnose
1. Open the Config drift panel on `/app/admin/settings`.
2. For each drifted key, compare **expected** (canonical) vs **actual** from `ADMIN_RUNTIME_CONFIG_URL`. The endpoint must return a fresh `observedAt`, active `contractId`, and every protocol parameter, sourced independently from the release baseline. If it is unavailable, the panel reports degraded instead of assuming a match.

### Remediate
1. Prefer restoring runtime values to the published release via a governance proposal (`/app/admin/proposals`).
2. If the drift is intentional, update canonical provenance in `lib/deployment-provenance.ts` (and release notes) in the same change set.
3. Restore the independent observation endpoint if it is stale or unavailable. A static environment value cannot prove current on-chain/runtime state.

---

## 4. Indexer health

Indexer soft/hard lag thresholds follow [`INDEXER_RUNBOOK.md`](./INDEXER_RUNBOOK.md)
(soft ≥ 100 ledgers → stale, hard ≥ 500 or `last_error` → degraded). Use that
runbook for checkpoint inspection, Horizon 429 recovery, and ledger rewind.

A missing or invalid recorded `last_success_sync_time` is returned as `null`
and degraded; the health reader does not substitute the observation time.
The zero `sync_lag` placeholder in this state, as in the no-checkpoint state,
does not establish freshness. Failed updates to an existing cached checkpoint
preserve its previous successful-sync timestamp even when the caller supplies
both the event ID and error explicitly. Only a successful update advances that
recorded history. Existing recorded-success lag and error handling are unchanged.
If the first checkpoint update fails, both the cache and database create path
store the Unix epoch (`1970-01-01T00:00:00.000Z`) as an explicit no-success marker.
The existing database column remains non-nullable; this marker survives Redis
serialization and database flushes, and the health response exposes it as `null`
with degraded status. A later successful update replaces it with the actual sync
time. Failed updates after a real success preserve that earlier timestamp.
This does not migrate old checkpoint data; timestamps fabricated by older
writers cannot be retroactively distinguished from recorded successful syncs.

```bash
curl -s "${NEXT_PUBLIC_BACKEND_URL:-http://localhost:3001}/health/indexer" | jq .
```

---

## 5. Local verification without live RPC

Unit tests inject probe snapshots into `lib/deployment-provenance.ts` so CI
covers healthy / stale / degraded without network access:

```bash
pnpm vitest run lib/deployment-provenance.test.ts app/app/admin/settings/page.test.jsx
```

Checkpoint persistence regressions exercise the production ledger and cache
classes over simulated database and Redis stores, including serialization,
flush/fallback, later success, failed retries and stale health:

```bash
cd backend
npm test -- tests/cache.spec.ts -t "never-successful indexer checkpoints"
```

## 6. Overlapping refreshes

Concurrent `GET /api/admin/health` calls in the same Node process share one
running dependency observation. Each caller receives its own consumable response
with the existing status and `Cache-Control: no-store`. The shared promise is
cleared on fulfillment or rejection; the next refresh starts new probes. There
is no completed-result TTL, persistent cache, or coordination between processes.
With runtime configuration enabled, one observation makes six upstream requests:
Horizon, three Soroban methods, indexer health, and runtime configuration.

Run the focused route check with Node 20 or newer:

```bash
node --experimental-vm-modules scripts/check-admin-health-concurrency.mjs
```

The command executes the complete route and its fetch/timeout logic over actual
loopback HTTP. Small import adapters isolate Next.js response serialization,
health classifiers, and Stellar codecs; it does not measure those dependencies,
a deployed Next.js server, real chain services, or cross-process sharing.
All failures exit nonzero. It checks independently consumable responses, fresh
observations after settlement, dependency failure/recovery, and collection
rejection/recovery. The existing classifier and UI checks remain separate.

One Node v24.19.0 execution on October 4, 2026, compared the preceding
`f51dc69b` route with this change using 25 ms loopback response delays:

| Flow | Callers | Before: upstream requests | After: upstream requests |
| --- | ---: | ---: | ---: |
| Overlapping refreshes | 25 | 150 | 6 |
| Refresh after completion | 1 | 6 | 6 |
| Dependency failure | 5 | 30 | 6 |
| Refresh after dependency recovery | 1 | 6 | 6 |
| Collection rejection | 5 | 30 | 6 |
| Refresh after collection rejection | 1 | 6 | 6 |

The initial burst used 96% fewer dependency requests. Its observed elapsed time
was 329.013 ms before and 68.998 ms after; this is one controlled
component observation, not a production latency estimate. Both complete
executions exited 0. Source SHA-256 values printed by the command:

- Before: `e0a217f4b98b9a6cd8d67dbbb3330c504dc3abd839d60ea512f1179577d41ac6`.
- After: `ffa81807ac6bacb236875e2fd83b64b2113dcfbb7daf1577efded9cb025385ea`.

To compare a retained original route, pass its file path followed by
`--uncoalesced`; that mode expects one probe set per caller and changes only
the check's request-count expectation. It does not modify the route source.
