# Deterministic Tamper-Evident Activity Export

Vaultquest provides deterministic, cryptographic activity export capabilities designed for compliance, external audits, and customer support verification.

## Core Objectives

- **Tamper Evidence**: Cryptographic SHA-256 digests over canonical record payloads ensure that any modification to amounts, timestamps, statuses, or addresses immediately invalidates the export checksum.
- **Privacy Redaction**: By default, confidential internal memos, API tokens, session data, and counterparty wallet addresses are masked to prevent accidental data leakage when sharing exports with third parties.
- **Deterministic Serialization**: Identical activity records produce byte-for-byte identical output regardless of object key insertion order, date sort order in memory, or system environment.
- **Multi-Format Interoperability**: Available in both structured JSON and RFC 4180 compliant CSV formats with spreadsheet formula injection protection.

---

## Provenance Metadata Envelope

Every exported artifact contains an envelope detailing origin, scope, and verification attributes:

| Field | Type | Description |
| :--- | :--- | :--- |
| `schemaVersion` | `string` | Semantic specification version (currently `1.0.0`) |
| `generatedAt` | `string` | ISO 8601 UTC timestamp of export creation (`YYYY-MM-DDTHH:mm:ss.sssZ`) |
| `scope.wallet` | `string` | Authenticated wallet address associated with the exported records |
| `scope.network` | `string` | Network scope (`testnet`, `mainnet`) |
| `recordCount` | `number` | Total number of activity entries in the artifact |
| `checksum` | `string` | 64-character lowercase SHA-256 hex digest of canonicalized records |

---

## Cryptographic Checksum Computation

The checksum protects the integrity of the transaction data:

1. **Sanitization**: Privacy redaction is applied according to user preferences.
2. **Canonicalization**:
   - Each record has its keys sorted alphabetically.
   - Null, undefined, and empty string properties are normalized.
   - Floating-point and numeric amounts are standardized to canonical number representations.
3. **Total Ordering**: Records are sorted deterministically:
   - Primary sort: `date` descending (ISO UTC timestamp).
   - Secondary sort: `id` ascending (alphabetical).
   - Tertiary sort: lexicographical JSON representation comparison.
4. **Hashing**: The serialized canonical JSON array is digested using SHA-256 via native cryptographic primitives:
   $$\text{checksum} = \text{SHA-256}(\text{serializeCanonicalRecords}(\text{records}))$$

---

## Privacy Redaction Protocol

When `redactSensitive: true` is enabled (default behavior):

### 1. Sensitive Field Masking
Any field key matching the following list is replaced with `"[REDACTED]"`:
`memo`, `privateMemo`, `note`, `notes`, `internalNote`, `secret`, `privateKey`, `apiKey`, `token`, `session`, `auth`, `authorization`, `email`, `phone`, `ip`, `ipAddress`, `ssn`, `password`, `internalId`, `stack`, `stackTrace`, `trace`.

### 2. Counterparty Address Masking
Counterparty and foreign addresses (such as `counterparty`, `recipient`, `fromAddress`, `toAddress`, `peerAddress`) are masked to their initial 4 characters:
- Stellar public key: `GABCD...1234` $\rightarrow$ `GABC...[REDACTED]`
- EVM public key: `0x1111...2222` $\rightarrow$ `0x11...[REDACTED]`
- The authenticated user's own scoped wallet address is preserved for proof of ownership.

### 3. Secret Pattern Detection
String values matching confidential secret structures (Bearer tokens, JWTs, Stellar seed keys starting with `S`, or 64-hex private keys) are automatically sanitized to `"[REDACTED_SECRET]"`.

---

## Supported Formats

### JSON Export Format
```json
{
  "metadata": {
    "schemaVersion": "1.0.0",
    "generatedAt": "2026-09-08T12:00:00.000Z",
    "scope": {
      "wallet": "0x1111111111111111111111111111111111111111",
      "network": "testnet"
    },
    "recordCount": 2,
    "checksum": "9d18d51a6f8db4e747269010c106b156bf1a2b5e73d0894f0131e60e5d04f5fa"
  },
  "records": [
    {
      "amount": 100,
      "asset": "USDC",
      "counterparty": "0x22...[REDACTED]",
      "date": "2026-06-01T12:00:00.000Z",
      "id": "tx-1",
      "memo": "[REDACTED]",
      "pool": "USDC Vault",
      "status": "confirmed",
      "type": "deposit",
      "walletAddress": "0x1111111111111111111111111111111111111111"
    }
  ]
}
```

### CSV Export Format
CSV files include the provenance envelope as metadata comments preceding the RFC 4180 table rows:

```csv
# schemaVersion: 1.0.0
# generatedAt: 2026-09-08T12:00:00.000Z
# wallet: 0x1111111111111111111111111111111111111111
# network: testnet
# recordCount: 2
# checksum: 9d18d51a6f8db4e747269010c106b156bf1a2b5e73d0894f0131e60e5d04f5fa
id,type,pool,asset,amount,date,status,txHash,counterparty,memo,walletAddress
tx-1,deposit,USDC Vault,USDC,100,2026-06-01T12:00:00.000Z,confirmed,,0x22...[REDACTED],[REDACTED],0x1111111111111111111111111111111111111111
```

#### Formula Injection Neutralization
To prevent spreadsheet formula execution exploits (CSV Injection), any cell value beginning with `=`, `+`, `-`, or `@` is prefixed with `'` (apostrophe) during CSV generation.

---

## Programmatic Audit Verification

Exports can be validated in CI/CD pipelines or independent audit tools using the library functions in `lib/activity-export.js`:

```javascript
import { verifyActivityExportJson, verifyActivityExportCsv } from "@/lib/activity-export";

// Verify JSON payload
const jsonAudit = verifyActivityExportJson(exportedJsonString);
if (!jsonAudit.valid) {
  throw new Error(`Audit failure: ${jsonAudit.reason}`);
}

// Verify CSV payload
const csvAudit = verifyActivityExportCsv(exportedCsvString);
if (!csvAudit.valid) {
  throw new Error(`Audit failure: ${csvAudit.reason}`);
}
```
