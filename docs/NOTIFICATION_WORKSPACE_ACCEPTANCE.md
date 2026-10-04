# Canonical notification workspace acceptance

## Dependency composition

The notification implementation remains exactly the source at
`256715910fac87e919b60e2b1f834f52e791605c`. Only the workspace configuration
and pnpm lockfile change; all feature, backend npm lock, migration and test
files are preserved.

The two dependency files reuse the already generated and tested correction
from [`08915ce6`](https://github.com/woahwhattheheck/vaultquest/commit/08915ce6cf89fcbc238319599d77ff41ff30bc7b),
rather than generating a different dependency graph. Its complete rationale
and earlier peer-resolution evidence are in
[the donor report](https://github.com/woahwhattheheck/vaultquest/blob/08915ce6cf89fcbc238319599d77ff41ff30bc7b/docs/FEE_OBSERVATION_VALIDITY.md#canonical-workspace-installation-follow-through).
Vitest remains on compatible 3.2.x and Vite on 6.4.x, with existing security
floors retained. The generated backend importer reflects its existing
manifest. The version-specific Solana WebSocket dependency and compatible
Zod peer contexts are reused unchanged. All three workspace members and all
15 existing `allowBuilds: false` entries are preserved.

Before installation, the native job compared all three complete package
manifests with the donor by Git blob identity. It also proved both old
notification dependency files equal the donor's original preimages at
`13992798d927883579f8c4c4505069b4f34b249b`.

| Path | Compared Git blob |
| --- | --- |
| `package.json` | `72f6c4c7ca14263cb9e5836368bb399798838d0d` |
| `backend/package.json` | `89c18f365b2200fb693134557b066810a89861a3` |
| `stellar-wallet-connect/package.json` | `453b5d24dc77ae19ee91b9baddb0c82cbe582c40` |
| Tested `pnpm-workspace.yaml` | `24b0f88d509b3fb6d4b62ce0918366697aacaf7f` |
| Tested `pnpm-lock.yaml` | `8c60c191836213cf9024f4c65616fbf59537e756` |

## Executed result

[Run 37199954184, job 111429423796](https://github.com/woahwhattheheck/vaultquest/actions/runs/37199954184/job/111429423796)
completed successfully on October 4, 2026. The isolated controller is
[`9630f546f0d8a35128fe66865c3ff5d07df6b396`](https://github.com/woahwhattheheck/vaultquest/commit/9630f546f0d8a35128fe66865c3ff5d07df6b396);
its [workflow](https://github.com/woahwhattheheck/vaultquest/blob/9630f546f0d8a35128fe66865c3ff5d07df6b396/.github/workflows/vq219-canonical-notifications.yml)
remains outside the contribution branch. That controller differs from the
original feature only by the two dependency postimages and its one workflow.

Actual versions: Node `v22.23.3`, pnpm `10.28.2`, Vitest `3.2.7`, Vite
`6.4.3`, jsdom `25.0.1`.

```sh
pnpm install --frozen-lockfile --reporter=append-only
pnpm exec vitest run lib/notification-prefs.test.js lib/notification-prefs-client.test.js lib/notification-producers.test.js lib/notification-proxy.test.js components/app/VaultNotificationSettings.test.jsx app/app/notifications/page.test.jsx --reporter=default --reporter=json --outputFile.json=evidence/notification-tests.json
```

The normal frozen installation includes **all three workspace projects**. It
completed in 15.9 seconds without temporary workspace exclusions, lock
regeneration, alternate node_modules links, script approvals or an
`--ignore-scripts` override. The six maintained files passed **42/42 tests**,
with zero failed, pending or todo tests and no snapshot changes. The runner
reported 3.91 seconds; these are single-run observations, not a speedup
benchmark.

| Existing test file | Passed |
| --- | ---: |
| `lib/notification-prefs.test.js` | 11 |
| `lib/notification-prefs-client.test.js` | 6 |
| `lib/notification-producers.test.js` | 7 |
| `lib/notification-proxy.test.js` | 10 |
| `components/app/VaultNotificationSettings.test.jsx` | 5 |
| `app/app/notifications/page.test.jsx` | 3 |

The selection covers defaults, preference persistence, client request and
response handling, producer gates, proxy behavior, wallet changes and the
rendered notification/settings flows. No assertion, test or application
source was changed to obtain this result. Dependency SHA-256 checks and a
clean tracked-tree check passed after the installation and test execution.

The [raw artifact](https://github.com/woahwhattheheck/vaultquest/actions/runs/37199954184/artifacts/11302632983)
contains the source identities, complete tracked manifest, dependency patch,
installation output, test log and JSON report, runtime versions and hashes.
Downloaded ZIP SHA-256:
`446b9cfff80c104d34557d13ff1aee2bd60ab60dcc71565d81b8daa52b18af64`.
The artifact has seven-day retention; the selected execution output and
source identities are also retained in this contribution.

## Scope limits

This establishes canonical installation and the existing six-file frontend
notification selection, not a full application build, live wallet, live
chain, production deployment or payout. The original separate 16-case
PostgreSQL/Testcontainers notification result from run `37193601213` is
preserved, not rerun or included in the 42 count. Its backend npm lockfile
repair remains unchanged.

The installer reports ignored scripts for `@reown/appkit@1.8.21`,
`@stellar/stellar-sdk@14.2.0`, `core-js@3.49.0` and `keccak@3.0.4` under the
retained policy. No approval was granted. Earlier unrelated peer warnings
and the donor report's scope limits remain; this is not a blanket dependency
compatibility or security certification.
