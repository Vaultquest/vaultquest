# Atomic action cancellation

Cancellation updates only a row whose status is still `pending` in the same database statement. Submission, confirmation and reversion that commit first are preserved; the losing cancellation returns `ILLEGAL_TRANSITION`. Repeated user cancellations return the stored first reason and detail. Missing targets retain `NOT_FOUND`.

The inherited unresolved Prisma schema is repaired using the existing #220 privacy-preserving correction from `dd369b16f589599c29cf21aacf49db441b1394f0`, without importing its unrelated JobLease model or worker changes. The identical corrected schema was used before and after the cancellation change.

## Focused PostgreSQL execution

```json
{
  "base": "093bec9f6e09e4d40e0a55035d2941b5fe42edee",
  "test_run": 37191663604,
  "artifact": 11299536328,
  "source_blobs": {
    "backend/src/services/ledger.ts": "5687a0790681073f50368b746da2316c2c58186e",
    "backend/tests/ledger.spec.ts": "a184889c6d453667c4fc91fc9abe8e6d5f18f526",
    "backend/prisma/schema.prisma": "2b06dc67754152305ab8ea598d10e24274e60777"
  },
  "results": {
    "before": {
      "passed": 4,
      "failed": 4
    },
    "after": {
      "passed": 8,
      "failed": 0
    }
  },
  "command": "node node_modules/vitest/vitest.mjs run tests/ledger.spec.ts -t 'LedgerService.cancelAction' --maxWorkers=1 --minWorkers=1",
  "runtime": "Node 22.16.0; Prisma 5.22.0; PostgreSQL 16-alpine through the existing Testcontainers helper"
}
```

All database operations were real PostgreSQL writes. A scoped Prisma query extension controls only the point at which a competing submission/confirmation/reversion commits before the cancellation write. Twenty unrelated tests in the file were not selected.

The initial test harness used spies on generated Prisma delegates; restoring those spies corrupted the delegate proxy. That harness was replaced by the scoped extension. The corrected run executes all eight selected cases: the old implementation fails four and the new implementation passes all eight. The workflow wrapper was red only because its result counter included skipped cases. The retained JSON/exit files establish the results above; publication reuses the exact tested source without rerunning the suite.

The runtime was installed from the committed npm lock using its recorded root manifest, because the product manifest has unrelated SendGrid/Stellar additions not in that lock. The original product manifest is unchanged. This is not a full-package installation, full application build, live blockchain, or across-process persistence claim. No dependency manifests, lockfiles, route authorization or signing behavior were changed.
