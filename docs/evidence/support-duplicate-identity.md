# Support ticket duplicate identity

Operation: VQ218-DUPLICATE-IDENTITY-20261003-DBED. This continues existing PR #218 and issue #117 on top of `2937a07e5f6f6f3788417e50db2cbf2247b1fa8a`, retaining the prior durable-store and draft/retry repairs.

## Failure and correction

The duplicate index used a 32-bit polynomial checksum as the identity of normalized email, category and description. Two different valid descriptions could share that checksum. In an actual `FileSupportTicketStore` run, separate submissions for `Please check reference a~.` and `Please check reference b_.` used different form keys but both received the first receipt. Only one JSONL record existed; the second request had never been persisted.

`duplicateFingerprint` now returns an unambiguous JSON encoding of the complete normalized tuple. Email casing, description casing and whitespace normalization remain the same. This key is internal to the in-memory duplicate index: the JSONL schema, HTTP receipt shape, explicit idempotency-key behavior and duplicate time window do not change. No new dependency or Node-only import is added to the shared helper. The larger key is bounded by the existing validated input limits; it is not persisted or sent to clients.

## Actual execution

The same native store operation changed from one persisted record and `duplicate: true` on the second request to two distinct receipts, two persisted records and `duplicate: false`. Reopening a fresh file-store instance restored both exact descriptions. All input identities and reference strings used here are illustrative.

The existing `lib/support-tickets.test.js` gained two cases: distinct content whose former short keys collide, and case/whitespace-equivalent content that must still deduplicate. The same 19-case selection on the original helper produced 1 failure and 18 passes. The repaired helper produced 19 passes. Both cases use the real file store and filesystem; the distinct-record case reopens the stored receipts. The 17 earlier validation, rate-limit, idempotency, append-failure, concurrent-retry and startup-recovery cases remain present and pass.

Command, from the scoped source checkout with the retained tool runtime on its module path:

```sh
node --max-old-space-size=256 /path/to/retained-runtime/node_modules/vitest/vitest.mjs \
  run lib/support-tickets.test.js --environment node --maxWorkers=1 --reporter=verbose
```

Runtime: Node 24.19.0, Vitest 4.1.9 and Vite 8.1.0. This reused a 47-package tool runtime already available from the preceding Neko repair. It performed no download, dependency installation or manifest/lockfile change. The repository currently declares Vitest `^2.1.8`; that runtime was not available in the retained cache, so this is explicitly an isolated focused run with a newer runner. The full workspace suite, Next application, UI, production build, route smoke checks and deployed intake were not run for this continuation. The prior UI screenshots and validation remain available in `docs/TESTING.md`.

## Duplicate recovery after process restart

The next continuation, on top of `673061be2b476f66e3beacd27dc984d47c107503`, found that JSONL startup restored receipts and explicit form keys but left the normalized duplicate-content index empty. Identical content with a new or missing form key was therefore accepted again immediately after a restart. The complete normalized identity correction above remains intact.

`FileSupportTicketStore` now rebuilds that index while loading persisted tickets. Each entry retains its original `created_at`, so restarting preserves the existing ten-minute window. Later accepted records with the same identity replace earlier entries in file order, matching the live store. No JSONL schema, HTTP shape, explicit-key policy, widget behavior or dependency changes are required.

### Regression results

Seven cases were added to the existing store suite: retries with a new or missing form key just before expiry, normalized casing/whitespace, exact expiry and one millisecond after it, recovery of the latest accepted equivalent receipt, and explicit-key replay after the content window expires. They use the real filesystem and a fresh file-store instance. Against the original loader, the selection produced **4 failures and 22 passes**; the repaired loader produced **26 passes**.

The exact focused command was:

```sh
TMPDIR=/dev/shm/vq218-tmp node --max-old-space-size=192 \
  node_modules/vitest/vitest.mjs run lib/support-tickets.test.js \
  --maxWorkers=1 --minWorkers=1 --reporter=verbose
```

The changed store and test file also pass the repository's `next/core-web-vitals` ESLint configuration, the product-term guard passes, and `git diff --check` is clean. This continuation reused Node 24.19.0, Vitest 2.1.9, Vite 5.4.21, jsdom 25.0.1, ESLint 8.57.1 and `eslint-config-next` 14.2.33. Vitest is now within the declared range; the sponsor's Node 20 matrix was not run.

### Native API evidence

The actual `app/api/support/tickets/route.js` and store were bundled with esbuild 0.21.5, using real Next 14.2.33 `NextRequest` and `NextResponse`. A thin native HTTP adapter delivered curl requests to those handlers. Every request used a separate Node process and the same JSONL file for that phase. Only the clock and receipt randomness were controlled; persistence, validation, normalization and route responses were real. The original and repaired phases used separate files. This exercises the handler across real process exits, rather than a full Next server or a deployed intake.

The first request used `original-form` at `2026-10-03T12:00:00.000Z`. After that process exited, the retry used a new key one second later:

```sh
curl --silent --show-error --max-time 10 \
  -H 'content-type: application/json' \
  --data-binary '{"name":"Ada Lovelace","email":"ada@example.com","category":"wallet","description":"Cannot connect Freighter on mobile Safari.","idempotency_key":"new-form"}' \
  "http://127.0.0.1:$PORT/api/support/tickets"
```

Before the repair, the retry returned **HTTP 201**, and the file contained two records:

```json
{"data":{"id":"VQ-20261003-777777","status":"accepted","created_at":"2026-10-03T12:00:01.000Z","duplicate":false}}
```

After the repair, the retry returned **HTTP 200** with the original receipt, and the file still contained one record:

```json
{"data":{"id":"VQ-20261003-3LLLLL","status":"accepted","created_at":"2026-10-03T12:00:00.000Z","duplicate":true}}
```

Nine native request/read controls passed after the repair:

| Request in a fresh process | HTTP result | JSONL records |
| --- | --- | --- |
| Initial ticket | 201, new receipt | 1 |
| Same content, new key at +1 second | 200, original receipt | 1 |
| Same content, missing key at +2 seconds | 200, original receipt | 1 |
| Equivalent casing/whitespace at +3 seconds | 200, original receipt | 1 |
| GET the persisted original receipt | 200, original receipt metadata | 1 |
| Different description at +5 seconds | 201, separate receipt | 2 |
| Original content at exactly +10 minutes | 201, new receipt | 3 |
| Original content one second after that | 200, latest equivalent receipt | 3 |
| Original explicit key after expiry | 200, original receipt | 3 |

### Limits of this continuation

The unchanged `SupportWidget.test.jsx` suite was included in one run but could not collect because the retained runtime lacks `nanostores`; that command had 26 passing store tests and one suite import failure. A subsequent store-only run exited successfully with all 26 tests. No widget pass is claimed for this continuation. Earlier UI evidence remains in `docs/TESTING.md` and was not replaced.

There was no dependency installation or manifest/lockfile change. The full workspace unit suite, Next production build, full application route smoke tests, Playwright E2E, deployed intake and Node 20 matrix were not run with this partial retained runtime and the shared workspace capacity limit. The native curl evidence above is scoped to the real API handler and durable store.

## Receipt recovery after an incomplete append

This continuation starts from `cc01c56bb5aeda5562fbd34245a70f7c72900e3d` on the existing PR #218 branch. A file ending in valid JSON without a final newline, or in an interrupted JSON fragment, exposed another acceptance failure. The store appended the next record directly onto that tail and returned success. On reopening, the combined line could not be parsed, so the newly accepted receipt disappeared. A valid final receipt without a newline also disappeared when joined to the new record.

The file store now remembers when the next append needs a leading newline. Startup derives that state from the existing bytes. Before an append, the store conservatively marks the boundary as uncertain and clears that state only after the write succeeds. A rejected append that left partial bytes therefore causes the next retry to start a separate line. The existing create queue serializes these operations.

The correction appends a separator without rewriting or truncating existing content. Valid receipts remain recoverable; malformed fragments retain their bytes and continue to be skipped by the existing loader. Empty and already newline-terminated files keep their normal record layout. Receipt visibility still follows successful persistence, and the JSONL schema, duplicate identity, original timestamps, explicit-key policy, API responses and widget behavior are unchanged.

### Store regressions

Three cases were added to the maintained `lib/support-tickets.test.js` suite:

- Preserve both receipts after appending to a valid final record without LF, including the original explicit-key replay.
- Recover a new receipt appended after truncated JSON while retaining the earlier valid receipt and exact original byte prefix.
- Reject an append that writes a real partial fragment before failing, then recover a successful same-key retry after reopening. The failed receipt remains absent, and subsequent replay returns the successfully persisted receipt.

The original 26 tests passed before editing. All **29 tests pass** with the repair. Running those same 29 cases against the exact preceding store produced **3 failures and 26 passes**, covering each new scenario. Prior append-failure, concurrent-retry, startup-recovery, validation, rate-limit and restart-deduplication cases remain present and pass.

The focused command uses the repository Vitest configuration and its existing setup file:

```sh
TMPDIR=/path/to/owned-temporary-directory node --max-old-space-size=192 \
  node_modules/vitest/vitest.mjs run lib/support-tickets.test.js \
  --maxWorkers=1 --minWorkers=1 --reporter=verbose

node node_modules/eslint/bin/eslint.js lib/support-ticket-store.js lib/support-tickets.test.js
node scripts/check-product-terms.js
git diff --check
```

The focused ESLint, product-term and diff checks pass. Runtime versions are Node 24.19.0, Vitest 2.1.9, Vite 5.4.21, jsdom 25.0.1, ESLint 8.57.1 and `eslint-config-next` 14.2.33, reused through owned links to retained packages. No dependency was installed or changed.

### Actual HTTP acceptance and restart readback

The actual ticket route and store were bundled with esbuild 0.21.5. A thin HTTP adapter passed curl requests through real Next 14.2.33 `NextRequest` and `NextResponse`. Each POST and GET ran in a separate Node process, using the same isolated filesystem file within a scenario. All 12 request processes in each phase exited successfully. Only receipt randomness and the clock were controlled; route handling, validation, JSONL writes, parsing and responses executed normally.

For each file condition, the flow created an original ticket, prepared the final-byte condition, submitted different valid content, then fetched both receipts after further process exits. The incomplete tail used the literal fragment `{"id":"interrupted`. All inputs were local illustrative fixtures.

| Existing final bytes before the second POST | Second POST, before / after | Original GET before | New GET before | Original GET after | New GET after |
| --- | --- | --- | --- | --- | --- |
| Valid record with LF | 201 / 201 | 200 | 200 | 200 | 200 |
| Valid record without LF | 201 / 201 | 404 | 404 | 200 | 200 |
| Valid record with LF, then incomplete JSON | 201 / 201 | 200 | 404 | 200 | 200 |

The existing bytes remained an exact prefix in every scenario. The separate direct-store probe also recovered both valid receipts in all three repaired scenarios.

The second POST used this request (the adapter supplied an ephemeral local port):

```sh
curl --silent --show-error --max-time 10 \
  -H 'content-type: application/json' \
  --data-binary '{"name":"Ada Lovelace","email":"ada@example.com","category":"wallet","description":"Different local support fixture","idempotency_key":"next-form"}' \
  "http://127.0.0.1:$PORT/api/support/tickets"
```

Both versions returned HTTP 201 with the same controlled receipt:

```json
{"data":{"id":"VQ-20261003-777777","status":"accepted","created_at":"2026-10-03T15:00:00.000Z","duplicate":false}}
```

After that process exited, a GET for `?id=VQ-20261003-777777` returned HTTP 404 on the preceding source for both incomplete-tail cases. With the repair, the fresh process returned HTTP 200:

```json
{"data":{"id":"VQ-20261003-777777","status":"accepted","created_at":"2026-10-03T15:00:00.000Z","category":"wallet"}}
```

### Boundary of this verification

This is real filesystem and process-restart evidence for the existing single-host store. It does not establish coordination between independent writers, recovery of the malformed fragment itself, or power-loss durability. The partial-append regression injects an I/O rejection after writing actual bytes; it does not simulate a physical storage failure.

The unchanged widget, full workspace suite, full Next application/build, route smoke/Playwright E2E, deployed intake and sponsor Node 20 matrix were not rerun for this store-only continuation. Earlier UI and API evidence remains above and in `docs/TESTING.md`. The previously documented workspace installation mismatch was not retried. Hosted CI and maintainer acceptance remain separate from these local results.

## Conflicting reuse of a recorded idempotency key

This continuation starts from `3d78bfda2ad72ee607528bc9286bdf69d7cb26af` on the same PR #218 branch. It deliberately tightens the previously tested first-wins contract: a key already recorded for a persisted ticket may replay its receipt only when the normalized submitted content matches. Previously, changing the description while reusing that key returned the first receipt with HTTP 200 although the different description was not stored.

The comparison uses normalized name, email, category, description, wallet hint, and schema version. Receipt metadata is excluded. A mismatch raises `IDEMPOTENCY_CONFLICT` before rate accounting, duplicate handling, or persistence. The API returns HTTP 409 with a fixed error message and no earlier receipt or ticket fields. The widget keeps the draft and, only for this known conflict on its current draft, discards the retry key. Its next explicit submission creates a fresh key; no automatic request is added.

This is an endpoint contract correction, not a demonstrated ordinary widget edit-loss failure. The existing widget already assigns new keys to changed payloads and ignores stale responses. The separate similarity-based duplicate path for new or absent keys remains broader than exact content matching, so its draft-preserving warning remains in place.

### Focused evidence

The two cases in `lib/support-idempotency-conflict.test.js` use the actual store modules and real temporary JSONL files. The preceding source fails both; the corrected source passes both. They cover normalized equivalent retries; changes to all five user-editable accepted fields; unchanged quota and prior ticket; two queued submissions; rejection after reopening storage; byte-preserving rejection; original receipt recovery; and a fresh-key submission of different content.

The existing idempotency case in `lib/support-tickets.test.js` now demonstrates a normalized equivalent retry. Its old changed-description expectation is intentionally superseded.

Maintained command, in the normal repository environment:

```sh
pnpm exec vitest run lib/support-idempotency-conflict.test.js lib/support-tickets.test.js
```

Observed here: Node 24.19.0 executed the two new cases with only their `describe`/`it` registration import changed from Vitest to `node:test`; all assertions and production modules were retained. The normal Vitest command and the earlier suite were not rerun. No package or dependency was installed.

An additional execution of the actual POST handler and file store used native `Response.json` at the `NextResponse.json` dependency boundary. Initial submission, conflicting reuse, original retry, and fresh-key recovery returned **201 / 200 / 200 / 201** before and **201 / 409 / 200 / 201** after. Only the conflict response lacked a receipt. This verifies handler branching with that adapter; it is not a native Next server, browser, deployed intake, or full application test. The four-line widget change was reviewed against its existing draft-ownership guard and uncertain-retry behavior; no React runtime execution is claimed.

## Durable keys for acknowledged content duplicates

Source base: `cd714bdb086e4ebf753f15cccd07b2795240c5c5`.

A content duplicate submitted with a new form key previously returned the original receipt without binding that new key. Reopening the JSONL after the ten-minute content window could therefore accept the acknowledged retry as a second ticket. The real-file reproduction returned one receipt for the first two submissions and a different receipt after restart and expiry.

The store now appends a typed `idempotency_alias` journal row before acknowledging a new key for duplicate content. That row binds the key and original receipt to a SHA-256 digest of the actual validated alias submission. This matters when the similarity rule considers differently cased or spaced descriptions equivalent: the alias must accept its own exact validated payload and reject changed details, even when those details match the canonical ticket.

Recovery rebuilds alias bindings without replacing the canonical ticket, changing its creation time, or renewing the content window. Ordinary primary keys keep the existing strict field comparisons. A later recovered primary row clears any earlier alias digest for its key, retaining the loader's existing later-primary-wins behavior. Rejected alias persistence does not acknowledge or reserve the key. The existing file writer queue, rate policy, line-boundary recovery and single-writer limitations remain in effect.

### Focused evidence and execution boundary

Before the executor disconnected, Node 24.19.0 with retained Vitest 4.1.10 dependencies ran the actual store modules and real temporary JSONL files: **8 selected cases passed, 0 failed; 28 cases were unselected**. Selection covered the two existing primary-key conflict cases, three new alias cases, and three existing keyed/unkeyed content-duplicate cases. The new cases checked restart plus original-window expiry, conflicts against the actual alias payload with receipt/byte/quota preservation, and rejected alias writes followed by recovery. Running the three new cases against the original source through the recorded Node test-registration adapter failed all three; its two original controls passed.

The production patch was recovered mechanically from the retained source preimage and the six reviewed edit blocks after the executor became unavailable. Maintained regression fixtures and this evidence text were reconstructed from the recorded assertions; byte identity with the executed fixture was not established, and the published tree was not rerun. The older wallet-context helper's unchanged-file assertion was also adjusted afterward to require three unchanged canonical tickets plus their three durable alias bindings; that assertion adjustment has only static review.

Commands for the maintained focused regressions in the normal repository environment:

```sh
pnpm exec vitest run lib/support-idempotency-conflict.test.js lib/support-tickets.test.js \
  -t 'support idempotency content|durable duplicate idempotency keys|reloads duplicate content without the original form key|keeps case and whitespace equivalent submissions as duplicates'
node --test scripts/check-support-wallet-dedupe.mjs
```

The observed Vitest run used an isolated Node environment and already-retained dependencies. No new install, full-suite result, sponsor-runtime result, Next server, UI, deployment, multi-writer coordination or power-loss durability is claimed.
