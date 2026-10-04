# Stellar fee observation validity

The provider boundary accepts positive safe integers supplied as JSON numbers
or decimal digit strings for both `last_ledger_base_fee` and `last_ledger`.
Malformed, missing, fractional, boolean, container or unsafe-integer values
raise an error instead of being presented as observed pricing or provenance.
The selector's existing failure path supplies the same 100-stroop fallback
with no source ledger and both stale indicators set. HTTP failure handling,
priority multipliers, simulation fees and the existing network/expiry fixes
are unchanged. This does not prove that a provider's well-formed value is true.

The fee payload and visible XLM amount now use seven decimal places, matching
the existing 10,000,000-stroops-per-XLM conversion. For example, 101 stroops is
shown as `0.0000101 XLM`, not rounded to `0.000010 XLM`. Fee selection, account
balance checks, USD-rate assumptions and Avalanche rendering are unchanged.

## Executed evidence and revision boundaries

Original source: `bc3ce9c1e33d3f2692b34a0cdcef42262e866dd2`.
[Original and initial candidate run](https://github.com/woahwhattheheck/vaultquest/actions/runs/37194233211):
34 passed / 33 failed before the repair; 65 passed / 2 failed afterward. All
33 new defect cases were repaired. The two remaining failures expected the
old six-decimal display strings for 5000 and 250 stroops.

This contribution updates those exact expectations to `0.0005000 XLM` and
`0.0000250 XLM`. Their numeric fee assertions and the equality checks remain;
no test is removed, skipped, or weakened. The production files and new
regression file are byte-identical to the first executed candidate.

[Final focused candidate run](https://github.com/woahwhattheheck/vaultquest/actions/runs/37194493752): 67 passed,
0 failed, 0 pending. The baseline is reused, not rerun in the final job.
Node `v24.21.0`; isolated Vitest 3.2.6 / Vite 6.4.3 / jsdom 25.0.1.
Other frontend runtime dependencies retain their locked versions.

```text
pnpm exec vitest run lib/chain-fee-adapters.test.js components/app/GasPrioritySelector.test.jsx lib/chain-fee-observation.test.jsx
```

Controlled HTTP responses exercise the actual adapter. Component checks mount
the actual selector and inspect its visible amount, freshness and parent
callback. No live Horizon or transaction is used.

## Initial isolated-run environment limits

This section records the earlier isolated runs. The canonical installation
limit is superseded by the follow-through below.

Three earlier setup attempts did not execute tests: the full workspace's
backend lockfile disagreed with its manifest; the frontend's retained
Vitest/Vite pairing failed before collection; and the isolated runner setup
initially assumed Vite was a root dependency instead of transitive-only.
Frontend installation temporarily excludes the unrelated backend and restores
the workspace file before source checks. Vitest and Vite links are redirected
only in untracked node_modules to the isolated compatible runner.

No product dependency manifest, lockfile or workspace file is changed. This
does not claim that canonical full-workspace installation is repaired. Raw
reports, source patch and sources are in the runs' artifacts; the isolated
runner lock is retained too. The first executed archive, artifact 11299379959,
has SHA-256 `cb6b570a0c23b55305053fcb9afd5b1dfb7aea1362508c1703c173e8d9e2ee69`.
Validation workflows remain outside this contribution branch. No application
build, full browser-wallet session, live-chain, performance, award or payout
result is claimed.

## Canonical workspace installation follow-through

The dependency correction starts from product source
`13992798d927883579f8c4c4505069b4f34b249b`. The fee implementation and all
67 existing focused tests remain unchanged.

The workspace overrides now keep Vitest on the compatible 3.2.x line and Vite
on 6.4.x while preserving their existing security floors. Canonical lock
generation also includes the backend's already-declared SendGrid and Stellar
SDK dependencies. A version-specific package extension supplies the existing
`ws@8.21.0` dependency to `@solana/rpc-subscriptions@2.3.0`, which provides
the compatible peer to its websocket-channel child. The first generated
candidate was held because this child had incidentally resolved to
incompatible `ws@7.5.13`; it was not published.

The final generated graph also selects existing Zod 3.25.76 in some
viem/wagmi/RainbowKit peer contexts. This satisfies `abitype@1.0.8`'s
`^3 >=3.22.0` requirement, which the earlier Zod 4.4.3 context did not.
Both Zod package versions and integrity records remain in the lock. These
compatible peer-context changes come from pnpm; resolution metadata was not
edited manually. Other overrides, all three workspace members, and all 15
existing `allowBuilds: false` settings are preserved. Canonical metadata also
adds the registry's deprecation notice for `prom-client@15.1.3` and marks the
retained Zod 4 context of `ox@0.6.9` optional; their package integrities are
unchanged.

### Executed commands and source binding

[Native job](https://github.com/woahwhattheheck/vaultquest/actions/runs/37196462222/job/111419277599)
completed successfully on Node `v22.23.3` and pnpm `10.28.2`.
The isolated validation controller is
[`aff184865e63cc45fd56c971b1743392bfd8e2c6`](https://github.com/woahwhattheheck/vaultquest/commit/aff184865e63cc45fd56c971b1743392bfd8e2c6),
workflow
[`.github/workflows/vq214-canonical-pnpm.yml`](https://github.com/woahwhattheheck/vaultquest/blob/aff184865e63cc45fd56c971b1743392bfd8e2c6/.github/workflows/vq214-canonical-pnpm.yml).

```sh
pnpm install --lockfile-only --no-frozen-lockfile --ignore-scripts --reporter=append-only
pnpm install --frozen-lockfile --reporter=append-only
pnpm exec vitest run lib/chain-fee-adapters.test.js components/app/GasPrioritySelector.test.jsx lib/chain-fee-observation.test.jsx
```

The first command only generates the lock. The complete frozen install uses
the repository's existing build-script policy without an `--ignore-scripts`
override or an approval change. Selected raw install records:

```text
Scope: all 3 workspace projects
Lockfile is up to date, resolution step is skipped
Packages: +1451
Done in 16.3s using pnpm v10.28.2
```

Installed runner versions were Vitest 3.2.7, Vite 6.4.3 and jsdom 25.0.1.
The existing three-file fee command passed all 67 tests. Selected raw summary
records (terminal styling removed):

```text
Test Files  3 passed (3)
     Tests  67 passed (67)
  Duration  2.27s
```
The native peer check resolved `ws/package.json` from each installed consumer
and independently checked the generated Solana snapshot edge:

```json
{
  "solana": [
    { "consumer": "@solana/rpc-subscriptions-channel-websocket", "ws": "8.21.0" }
  ],
  "retained": [
    { "consumer": "@walletconnect/jsonrpc-ws-connection", "ws": "7.5.13" },
    { "consumer": "@walletconnect/jsonrpc-ws-connection", "ws": "7.5.13" }
  ],
  "matchingLockEdges": 1
}
```

The generated files' SHA-256 checks remained unchanged after both the frozen
install and the fee command. Exact tested Git blobs:

| File | Git blob |
| --- | --- |
| `pnpm-workspace.yaml` | `24b0f88d509b3fb6d4b62ce0918366697aacaf7f` |
| `pnpm-lock.yaml` | `8c60c191836213cf9024f4c65616fbf59537e756` |

[Artifact 11300923433](https://github.com/woahwhattheheck/vaultquest/actions/runs/37196462222/artifacts/11300923433)
contains the generated postimages, source patch, full lock-generation/frozen-
install/focused-test output, runtime versions, peer records and source hashes.
Its downloaded ZIP was verified against SHA-256
`9680fcd9518fc397518ea28ae5b992c865a2e9361400fd03e6f3b8e59c7a21d9`.

This establishes canonical workspace installation and execution of the
existing focused fee command for these exact generated sources. Other
pre-existing peer warnings remain; the peer checks establish the specific
Solana and WalletConnect bindings above. They do not exercise wallet
connections, a full application build or live-chain behavior.

## Observation-time continuation — October 4, 2026

The Stellar estimate and freshness classifier now share the same observation
time validation. An invalid date, a non-finite caller clock, or a sample ahead
of that clock has unknown age (`ageMs: null`) and is stale. An invalid date
also produces `freshness: null`, so formatting the estimate does not throw.
A valid timestamp ahead of the caller clock is still reported as its original
ISO timestamp; it is not changed into a zero-age observation.

Valid zero-age samples remain fresh. The existing 60,000 ms threshold is
unchanged: 59,999 ms is fresh and 60,000 ms is stale. Ledger requirements,
unsupported-network precedence, all fee arithmetic, provider validation, the
selector's context/expiry handling and the canonical dependency files remain
unchanged.

### Focused execution

The unchanged production source from parent
`08915ce6cf89fcbc238319599d77ff41ff30bc7b` was compared with this repair using
the same maintained `lib/chain-fee-adapters.test.js` file. The file contains
the eight original cases plus four observation-time regressions.

| Source | Passed | Failed |
| --- | ---: | ---: |
| Parent | 9 | 3 |
| Repair | 12 | 0 |

The parent failures are the malformed observation date, future observation,
and invalid caller-clock cases. The zero-age/exact-threshold regression and
all eight original cases pass on both sources. The repaired cases exercise
both `classifyFeeFreshness` and `buildStellarFeeEstimate`; no test was removed
or skipped.

Exact Git blobs used in the final comparison:

| File | Git blob |
| --- | --- |
| Parent adapter | `0d1c722179059f827330cf8d508de0675c2c2967` |
| Repaired adapter | `a855bc6422a9c4f062f4d476c7e2bb8dd41bb7ae` |
| Maintained test file with regressions | `81c0b0b9e9877bb307f294f09a2447d4607d28cc` |

Execution used Node 24.19.0 and an already-installed Vitest 4.1.10 with its
Vite 8.1.5, in an isolated Node environment. The actual adapter and
`customRpc.js` were imported through an `@/lib` alias. The unrelated
`wagmi/chains` import was supplied only its two static Avalanche RPC
constants; wallet/chain integration was not exercised. Temporary/cache
directories were on cloud memory storage because the shared filesystem was
full; initial runner attempts stopped before test collection until that
temporary directory was configured. No dependencies were installed or changed.

The maintained repository command for this file is:

```sh
pnpm exec vitest run lib/chain-fee-adapters.test.js
```

The execution above uses the isolated runtime described here, not the earlier
canonical pnpm environment. It does not repeat or extend the prior 67-case
component/installation acceptance, and does not claim a mounted selector,
browser, provider, transaction, application build, or performance result.
