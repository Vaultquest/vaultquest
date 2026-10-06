# Canonical account workspace acceptance

## Reused dependency correction

Account feature source is preserved exactly at
`cb01a810fbacba8333bcbf4af329c3b5555f9065`. This continuation changes only
`pnpm-workspace.yaml`, `pnpm-lock.yaml`, and this evidence document. The
account UI, wallet-chain behavior, production fixture boundary, maintained
tests and earlier bundle evidence are unchanged.

The dependency postimages are reused from
[`08915ce6cf89fcbc238319599d77ff41ff30bc7b`](https://github.com/woahwhattheheck/vaultquest/commit/08915ce6cf89fcbc238319599d77ff41ff30bc7b),
whose [report](https://github.com/woahwhattheheck/vaultquest/blob/08915ce6cf89fcbc238319599d77ff41ff30bc7b/docs/FEE_OBSERVATION_VALIDITY.md#canonical-workspace-installation-follow-through)
explains the compatible Vitest/Vite lines, backend importer correction,
scoped Solana WebSocket dependency and pnpm-generated peer context changes.
There is no new dependency resolution in this continuation. Existing
security floors, all three workspace members and all 15 false build-script
permissions remain in place.

The native job verified complete manifest equality with the donor and
verified both original dependency files against donor preimages at
`13992798d927883579f8c4c4505069b4f34b249b` before installing anything.

| File | Exact Git blob |
| --- | --- |
| `package.json` | `72f6c4c7ca14263cb9e5836368bb399798838d0d` |
| `backend/package.json` | `89c18f365b2200fb693134557b066810a89861a3` |
| `stellar-wallet-connect/package.json` | `453b5d24dc77ae19ee91b9baddb0c82cbe582c40` |
| Tested `pnpm-workspace.yaml` | `24b0f88d509b3fb6d4b62ce0918366697aacaf7f` |
| Tested `pnpm-lock.yaml` | `8c60c191836213cf9024f4c65616fbf59537e756` |

## One actual canonical execution

[Native run 37200266297](https://github.com/woahwhattheheck/vaultquest/actions/runs/37200266297)
completed successfully on October 4, 2026, using isolated controller
[`1b5eb86f91c226d9f5b7e3db894c35a1a8eb7913`](https://github.com/woahwhattheheck/vaultquest/commit/1b5eb86f91c226d9f5b7e3db894c35a1a8eb7913).
Its [workflow](https://github.com/woahwhattheheck/vaultquest/blob/1b5eb86f91c226d9f5b7e3db894c35a1a8eb7913/.github/workflows/vq217-canonical-account.yml)
stays outside the contribution branch. The controller differs from the
feature only by the two dependency files and that workflow.

Actual environment: Node `v22.23.3`, pnpm `10.28.2`, Vitest `3.2.7`, Vite
`6.4.3`, jsdom `25.0.1`.

```sh
pnpm install --frozen-lockfile --reporter=append-only
pnpm exec vitest run lib/account-wallet-state.test.js app/app/account/page.test.jsx --reporter=default --reporter=json --outputFile.json=evidence/account-tests.json
```

The normal frozen installation included all three workspace projects and
completed in 13.9 seconds. No workspace exclusion, alternate runner,
regenerated lock, package script approval or `--ignore-scripts` override
was used. The complete existing selection passed **21/21 tests**: 15 helper
cases and six account component cases. There were zero failed, pending or
todo tests and no snapshot changes. No test was added or modified here.
The runner reported 1.19 seconds; this is one observation, not a performance
comparison.

Selected raw output, with terminal color escapes removed:

```text
Scope: all 3 workspace projects
Lockfile is up to date, resolution step is skipped
Done in 13.9s using pnpm v10.28.2

lib/account-wallet-state.test.js (15 tests) 5ms
app/app/account/page.test.jsx (6 tests) 264ms

Test Files  2 passed (2)
     Tests  21 passed (21)
  Duration  1.19s
```

Dependency SHA-256 checks and clean tracked-tree checks passed after both
installation and execution. [Artifact 11301703591](https://github.com/woahwhattheheck/vaultquest/actions/runs/37200266297/artifacts/11301703591)
retains complete source binding, tracked manifest, dependency patch,
installation/test logs, JSON results, versions and hashes. Its downloaded
ZIP was verified against SHA-256
`e425aa563c6ca8b1b05e597fa38c4299495a90b6516244720c280e007fc3631f`.
The artifact has seven-day retention; the selected output and source
identities above are retained in Git.

## Limits

This is canonical workspace installation plus the existing account helper
and component selection. Earlier production-bundle evidence stays pinned
to its original source and was not rerun. No full application build,
Playwright browser session, live wallet/chain, provider performance,
production deployment or award/payment result is claimed.

The installer still reports ignored package scripts for
`@reown/appkit@1.8.21`, `@stellar/stellar-sdk@14.2.0`, `core-js@3.49.0` and
`keccak@3.0.4` under the retained policy. No approval was granted. The donor
report's other peer warnings and scope limits are not a blanket dependency
compatibility or security certification.

## Mismatch-only fixture guidance (October 4, 2026)

An explicitly authorized `?networkMismatch=true` fixture can represent a
network mismatch while the wallet provider is disconnected. The account
resolver already supported that state, but neither rendering branch displayed
its guidance. The disconnected branch now passes the existing mismatch and
disconnect flags to `WalletReconnectGuidance` when either is active. It keeps
the empty account view and does not create a connected dashboard.

The fixture gate, wallet provider, helper, dependency files and prior cases
are unchanged. Two cases were added to the existing component file. Both run
with production mode and the build-time override disabled; only the runtime
E2E authorization differs. The authorized case shows mismatch guidance, while
the unauthorized URL retains ordinary disconnected guidance.

[Run 37201649307](https://github.com/woahwhattheheck/vaultquest/actions/runs/37201649307)
reused the released canonical account controller on source
`fcd85bdefc1f6f20859187832b56dec586d04977`, with the two candidate files.
Its [job log](https://github.com/woahwhattheheck/vaultquest/actions/runs/37201649307/job/111434395531)
records these results:

| Selection | Observed result |
| --- | --- |
| Previous page with only the two new `mismatch-only` cases selected | Authorized case failed; unauthorized case passed. Six existing component cases were not selected. |
| Repaired page, complete existing account helper/component selection | **23 passed**, zero failed or skipped: 15 helper cases and 8 component cases. |

The single frozen installation included all three workspaces and preserved the
dependency bytes. The run used Node 22.23.3, pnpm 10.28.2, Vitest 3.2.7,
Vite 6.4.3 and jsdom 25.0.1. The repaired selection reported 1.57 seconds;
this is an execution observation, not a performance comparison.

The exercised page blob is `be5e9e794b2bc0c50f6ebe296810e4e9e130ebcd`;
the component-test blob is `c2472f12d1c90b4b9294bb9092da3b6591e9c742`.
The [controller source](https://github.com/woahwhattheheck/vaultquest/blob/fb995d5640ec74a971ac5d14bdf74fc6613ce633/.github/workflows/vq217-canonical-account.yml)
retains the exact baseline and repaired commands. Logs, JSON results and source
binding are in artifact `11302828724` on that run, with seven-day retention.

This is mounted component/helper execution using the maintained isolation of
unrelated widgets and wallet controls. No new full Next build, browser capture,
live-wallet interaction, deployed-service result or award/payment is claimed.
Earlier browser and production-fixture compilation evidence remains bound to
its recorded sources.
