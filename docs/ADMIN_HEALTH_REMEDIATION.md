# Admin Operational Health & Remediation Runbook

This runbook guides operators and administrators in diagnosing and resolving operational alerts surfaced on the VaultQuest Admin Settings console (`/app/admin/settings`).

---

## 1. System Architecture & Health States

The admin settings console monitors four critical operational dimensions:

1. **Stellar Horizon & Soroban RPC**: Live connectivity, response latency, and network passphrase integrity.
2. **Event Indexer**: Ledger synchronization sequence, block lag, and processing errors.
3. **Smart Contract Bytecode Hash**: Cryptographic verification of deployed contract bytecode against canonical release provenance.
4. **Configuration Drift**: Verification that active runtime parameters (round duration, deposit caps, treasury fees, multisig quorum) match canonical deployment provenance.

### Health State Definitions

| State | Semantic | Visual Indicator | Operational Impact | Action Required |
|---|---|---|---|---|
| **Healthy** | All checks pass within normal thresholds | Emerald badge (`CheckCircle2`) | Normal operations | None. Routine monitoring. |
| **Stale** | Elevated latency or sync delay within soft limits | Amber badge (`Clock3`) | Minor UI or sync delay | Monitor catch-up progress; check logs if sustained > 10m. |
| **Degraded** | Endpoint down, hard error, bytecode mismatch, or critical config drift | Red/Amber badge (`AlertTriangle`) | Deposits, claims, or governance actions blocked | Immediate operator intervention required. |

---

## 2. RPC Health Remediation

### Symptoms & Classification
* **Stale (Latency >= 1500ms):** RPC is reachable but sluggish. May cause user wallet transaction delays.
* **Degraded (Unreachable / HTTP 5xx / Timeout):** RPC cannot process read or simulation requests.
* **Degraded (Network Passphrase Mismatch):** RPC endpoint points to an incorrect network (e.g. Mainnet instead of Testnet).

### Diagnostic Steps
1. Verify endpoint accessibility using `curl`:
   ```bash
   curl -i -X POST https://soroban-testnet.stellar.org \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
   ```
2. Verify Stellar Horizon root response and passphrase:
   ```bash
   curl -s https://horizon-testnet.stellar.org | jq '{network_passphrase, horizon_version}'
   ```
3. Check for HTTP 429 (Rate Limiting). Public SDF testnet endpoints enforce rate limits.

### Remediation Actions
* **If Rate Limited:** Switch to a dedicated RPC provider or custom RPC endpoint via admin settings or `.env.local` (`NEXT_PUBLIC_HORIZON_URL`, `NEXT_PUBLIC_SOROBAN_RPC_URL`).
* **If Network Passphrase Mismatches:** Update `NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE` in environment configurations and restart the service.
* **Failover:** If primary RPC is degraded, configure fallback RPC nodes in `lib/customRpc.js`.

---

## 3. Event Indexer Health Remediation

The VaultQuest Event Indexer tracks ledger events for user deposits, prize draws, and claim receipts.

### Sync Lag Thresholds
* **Healthy:** Sync lag <= 5 ledgers (< 25 seconds).
* **Stale (Soft Lag):** 6 to 100 ledgers behind. Catch-up process is active.
* **Degraded (Hard Lag):** > 100 ledgers behind OR `last_error` reported.

### Diagnostic & Recovery Procedures
1. Inspect the live indexer health endpoint:
   ```bash
   curl -X GET https://api.vaultquest.io/health/indexer
   ```
2. For in-depth recovery, database checkpoint resets, and manual ledger rewinds, consult the dedicated runbook:
   * **Reference:** [Indexer Operations Runbook](INDEXER_RUNBOOK.md)

---

## 4. Smart Contract Provenance Remediation

### Overview
VaultQuest deploys reproducible Soroban contracts. Canonical deployment provenance records the expected WASM SHA-256 hash in `lib/deployment-provenance.ts`.

### Classification
* **Healthy:** Deployed bytecode hash matches canonical release hash:
  `sha256:7f4c9c18d8e3b3e6488d907f1a30f305dbf2d93e25b1f1ac76bca9ef1587d552`
* **Stale:** Contract hash verification is pending, timed out, or awaiting RPC ledger lookup.
* **Degraded:** Bytecode hash mismatch detected.

### Hash Mismatch Investigation
A contract hash mismatch indicates that the deployed contract address points to an unknown WASM build, an unauthorized upgrade occurred, or an incorrect contract address was configured.

1. Inspect the active contract ID in `NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID`.
2. Inspect the contract bytecode on-chain via Stellar CLI:
   ```bash
   stellar contract inspect --id <CONTRACT_ID> --network testnet
   ```
3. Compare the resulting WASM hash against git tag release artifacts:
   ```bash
   sha256sum target/wasm32-unknown-unknown/release/drip_pool.wasm
   ```
4. If an unauthorized upgrade is confirmed, initiate the multisig rollback proposal per the governance runbook.

---

## 5. Configuration Drift Remediation

### Overview
Configuration drift occurs when active runtime parameters diverge from canonical baseline values defined in deployment provenance.

### Monitored Parameters

| Parameter | Canonical Value | Severity if Drifted | Operational Consequence |
|---|---|---|---|
| `treasuryFee` | `0.75%` | **Critical (Degraded)** | Yield distribution miscalculation |
| `settlementQuorum` | `3 of 5` | **Critical (Degraded)** | Multisig governance threshold altered |
| `emergencyPauseThreshold` | `2 failed attempts` | **Critical (Degraded)** | Safety circuit-breaker modified |
| `contractId` | Canonical Release ID | **Critical (Degraded)** | Interactions routed to incorrect contract |
| `roundDuration` | `7 days` | **Warning (Stale)** | Round cadence misaligned with schedule |
| `minDeposit` | `100 XLM` | **Warning (Stale)** | Churn risk on small deposits |
| `maxDeposit` | `250,000 XLM` | **Warning (Stale)** | Concentration risk altered |

### Remediation Actions
1. Review the drift table on `/app/admin/settings` to inspect drifted parameters, canonical values, and active runtime values.
2. For critical parameter drift (`treasuryFee`, `settlementQuorum`, `emergencyPauseThreshold`):
   * Navigate to **Admin Proposals** (`/app/admin/proposals`).
   * Draft a multisig proposal to reconcile parameters back to canonical values.
   * Collect required quorum signatures (`3 of 5`) before execution.
3. For environment variable drift:
   * Reconcile `.env` or deployment platform secrets (Vercel / Cloud Run) with the values specified in [Environment Variable Inventory](env-inventory.md).
   * Redeploy the frontend or backend instance to apply synchronized values.
