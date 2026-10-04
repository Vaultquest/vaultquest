# Wallet notification preferences

Preferences for issue #118 live in PostgreSQL under the wallet principal established by the existing `requireWalletAuth` middleware. The Next.js routes forward the caller's signed wallet headers. They do not substitute an internal service credential for a wallet supplied in a URL or body.

## Load, save, and conflict behavior

- `GET /notification-prefs?wallet=G...` returns `{ data: { version, wallet, prefs, updatedAt, revision } }`.
- `PUT /notification-prefs` accepts `{ wallet_address, prefs, expectedRevision }`. An optional `version` must be `1`.
- A missing record returns version-1 defaults, `revision: 0`, and `updatedAt: 0`. It does not create a row until the wallet saves.
- The first save creates revision 1. Later saves atomically match the revision loaded by that device. A stale create or update returns HTTP 409 without replacing the current record.
- `updatedAt` is an epoch timestamp in milliseconds. Browser storage is only a cache of acknowledged server state; a failed save does not display success or replace that cache.
- Invalid preference shapes, non-boolean choices, unknown fields, and attempts to disable mandatory security notices are rejected. Unreadable or newer encrypted records return HTTP 409 and are left intact.

The UI asks the user to load saved preferences explicitly. Each load or save requests a fresh wallet signature, so rendering and React StrictMode do not open signing dialogs. Saving is enabled after the server revision is loaded. HTTP 409 keeps unsaved choices visible and asks the user to reload before retrying. Wallet changes invalidate pending reads and saves.

## Existing authentication and middleware

Wallet requests supply `x-wallet-address`, `x-wallet-timestamp`, and `x-wallet-signature`. The challenge remains `vaultquest:actions-export:<wallet>:<timestamp>` for compatibility with the existing guard. The client accepts the wallet kit's hex or base64 signature representation and sends canonical base64 for 64 bytes. Verification supports the [SEP-53 signed-message digest](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0053.md) and existing raw Ed25519 challenges. The original freshness, replay, and cross-wallet checks remain active.

The backend's existing CSRF check also applies to PUT. The Next.js proxy obtains a matching cookie/token pair from the unprivileged backend health route before forwarding the single-use wallet proof to the intended save. The proxy never forwards browser cookies, API keys, or internal secrets supplied by the caller. Existing rate limits remain in force.

## In-app delivery

`GET /notifications?wallet=G...&limit=100` requires the same wallet proof and reads that wallet's existing action ledger. Preferences are applied before the response reaches the notifications page. The default limit and maximum are 100; pending actions are omitted. The limit counts enabled notices: preferences are applied in the database query before its limit, so newer opted-out actions do not hide older enabled notices. Results describe recorded action outcomes, with no invented amounts, winners, or vault names.

| Recorded action | In-app category | Preference | Default |
| --- | --- | --- | --- |
| Confirmed deposit | Deposit | `deposits` | Off |
| Confirmed claim | Prize claim | `winnings` | On |
| Confirmed select-winner action | Draw action | `roundUpdates` | On |
| Other non-pending action outcomes | Action status | `actionStatus` | On |
| Existing mandatory security producer | Security | Always enabled | On |

The notifications page no longer renders sample notices. Loading its history is an explicit wallet action. Read/unread selection remains local to the current page session; this change does not add read-state persistence, email, push delivery, scheduled jobs, or a new event ingestion source. The existing generic producer helpers call a supplied sender only when allowed, never report delivery without a sender, and do not let unavailable optional preference storage block mandatory security notices.

## Storage and migration

Apply `20261003000000_feature_notification_preferences` before deploying the routes. It creates `user_notification_prefs`, with a unique wallet/category key, encrypted preference payload, key version, and positive save revision. It uses the existing `PrivacyEncryptionService` and normalized wallet key already used by privacy export/deletion. Keep the existing `PRIVACY_MASTER_KEY` configuration consistent across backend replicas and restarts; the server now forwards that configured value into `buildApp`. The Prisma schema's conflicting duplicate preference definitions are reconciled to that encrypted model.

Upgrade consideration: older server startup code ignored `PRIVACY_MASTER_KEY`. If other privacy rows were already encrypted with the legacy default despite a configured key, arrange their explicit key migration before deploying with a different master key. This change does not re-encrypt existing rows and does not silently retry decryption with the legacy default.

The legacy file-store helper remains for existing consumers, including its concurrent-write and failure-preservation behavior; the application API uses the shared PostgreSQL service.

## Verification

`tests/notification-preferences.spec.ts` exercises actual Fastify application middleware, real Ed25519 signatures, Prisma reads/writes, cross-wallet rejection, replay rejection, stale revisions, ciphertext, future-format preservation, and category filtering. By default it uses the repository's disposable PostgreSQL Testcontainers helper. A disposable database with migrations already applied can be supplied through `VQ_NOTIFICATION_TEST_DATABASE_URL`; the suite creates fresh synthetic wallets and deletes only its own test records.

The two simultaneous-write regressions require a PostgreSQL runtime with reliable independent connections. The local PGlite socket multiplexer closes connections nondeterministically under that contention, so its results are not native PostgreSQL concurrency evidence. The focused checks do not replace the repository's full build and native PostgreSQL suite.

### Local verification — 2026-10-03

- 62 focused frontend/client/proxy/preference/producer/page/wallet-service tests passed across nine files with the repository Vitest configuration.
- 13 backend tests passed through the real Fastify application and Prisma, including signed saves, independent-client reloads, stale HTTP 409, canonical privacy keys, and category filtering. The two simultaneous-write cases were explicitly excluded from this local PGlite run and remain in the native PostgreSQL suite.
- Prisma 5.22 validation and generation passed. All 11 migrations deployed to the disposable PostgreSQL engine. Focused backend lint and strict type checks passed; the full backend typecheck still reported 33 diagnostics in unmodified files.
- Chromium rendered the actual compiled before/after settings components and repository styles. An ephemeral Ed25519 key signed real SEP-53 requests through the production client, proxy, Fastify middleware, and disposable database. Signed GET and PUT returned 200; a signed reload retained the saved deposit preference. The initial page made no signing request, read/save used fresh proofs, page/console error checks were clear, and the 390-pixel view had no horizontal overflow.

[Before settings](../../docs/images/notification-preferences-before.png) · [After acknowledged save](../../docs/images/notification-preferences-after.png)

The browser check used a synthetic signer, not an installed wallet extension, and compiled the source components rather than building the entire Next.js application. It is not a production rollout or native PostgreSQL contention result.

### History-limit repair — 2026-10-04

The maintained `counts only enabled notices toward the history limit` case adds 100 newer opted-out deposits, two older enabled notices, a foreign-wallet action, and a pending action. It checks the default and one-item limits, then a two-item deposit-only limit after a saved preference change. Run it with `pnpm exec vitest run tests/notification-preferences.spec.ts -t "counts only enabled notices"` from `backend`.

Local Node 24.19.0 execution of the actual history and notification-mapping method bodies, with native TypeScript erasure and an injected query fixture, reproduced empty default history before the repair and both enabled notices afterward. All 48 combinations of the four optional preferences and limits 1/2/100 matched the existing mapping across all current action types/statuses and a foreign-wallet control; 14 combinations failed before the repair. This was a source-level query-fixture check. The new maintained Prisma/Fastify/PostgreSQL case was added but not run in that environment; the dated integration results above remain separate.

### Native backend verification — 2026-10-04

[Owner-fork run 37193601213](https://github.com/woahwhattheheck/vaultquest/actions/runs/37193601213) passed all 16 cases in `tests/notification-preferences.spec.ts`, with zero failures, skipped cases, or todo cases. This includes the history-limit repair and both simultaneous-save regressions, using the actual Fastify application, Prisma, and the repository's normal `postgres:16-alpine` Testcontainers helper. The runner used Node 22.23.3, npm 10.9.9, Prisma 5.22.0, Fastify 4.29.1, Vitest 2.1.9, and `@testcontainers/postgresql` 10.28.0.

The run checked out product commit `bd3fb8ffc552aa4da570931dcf806e9e0ba81c66` and used backend lock blob `6c5d61cc34d687e5e977ee82a10918da8bb55526`. `npm ci`, the installed Axios/form-data/hasown dependency-tree check, and Prisma generation passed before the spec. Source and test hashes were unchanged afterward. The synchronized lock adds the manifest's existing SendGrid/Stellar declarations while retaining every previously locked version and integrity value; newer form-data/hasown required by the added Axios dependency are nested under Axios. The manifest is unchanged.
