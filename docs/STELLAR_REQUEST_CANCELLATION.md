# Stellar fee request cancellation

## Change — October 4, 2026

The fee selector already ignored late results from obsolete effects, but left their Horizon requests running. Each fee-loading effect now owns an AbortController. Its signal is forwarded by `fetchStellarFeeStats`; cleanup first marks the effect cancelled, then aborts its request. The existing cancelled guards still suppress stale errors, results and loading updates. A replacement effect receives a separate live signal.

The optional adapter argument preserves callers that omit it. Fee arithmetic, provenance/context masking, observation expiry, custom RPC validation and the independently routed Avalanche fetch path are unchanged. This cancels obsolete client requests; it does not undo provider work already received or guarantee reduced provider billing or rate-limit consumption.

## Executed evidence

[Native run 37205268716 / job 111445042286](https://github.com/woahwhattheheck/vaultquest/actions/runs/37205268716/job/111445042286) executed on October 4, 2026, at 13:20 UTC. The original source was `866308adfd78bf01d7827ef7a3933d682913058d`. The isolated controller is `480d16eb6cefe11b9c15e1cee9739e68f824a178`; its workflow is not part of the product branch.

Exactly two maintained React lifecycle cases were run before and after the patch. Both failed on the original because no AbortSignal reached fetch. Both passed on the candidate, with zero failed, pending or todo cases. The first case exercises source replacement, abortion of the old request, an independent live replacement signal, and rendering a successful replacement ledger without an abort warning. The second exercises unmount cancellation without a late onChange callback.

```sh
pnpm install --frozen-lockfile --reporter=append-only
pnpm exec vitest run components/app/GasPrioritySelector.abort.test.jsx \
  --maxWorkers=1 --minWorkers=1 --reporter=default --reporter=json \
  --outputFile.json=evidence/after.json
```

Normal frozen installation completed all three workspace projects in 17.8 seconds. Existing dependency and build-script permission files were preserved. Runtime: Node 22.23.3, pnpm 10.28.2, React 18.3.1, Vitest 3.2.7, Vite 6.4.3, jsdom 25.0.1 and wagmi 2.19.5. Candidate execution reported 1.74 seconds total / 125 milliseconds of tests; these are test-run durations, not application-performance measurements.

Content-addressed production inputs:

| File | Before blob | Validated candidate blob |
|---|---|---|
| `lib/chain-fee-adapters.js` | `a855bc6422a9c4f062f4d476c7e2bb8dd41bb7ae` | `7ddd6ef7c0d7a76c9277bd7e59adf110e9d5d355` |
| `components/app/GasPrioritySelector.jsx` | `eb2dcee484afadc62a5849ee2969c15e88ac25a2` | `49bcb082e9b6a7f5256486842e67ae9201d2d964` |

Maintained test blob: `8365af75685aa6fab0842943bc6f20397f1f35ec`. The runner applied strict single-match replacements and checked candidate blob identities, dependency hashes and unchanged unrelated tracked files before uploading the two validated source objects. It did not update a product ref or PR.

[Retained raw evidence artifact 11304093915](https://github.com/woahwhattheheck/vaultquest/actions/runs/37205268716/artifacts/11304093915) contains both JSON reports and logs, install/runtime records, dependency hashes, tracked inputs, patch and receipt. Runner-reported archive size: 26,435 bytes; SHA-256: `b9facf2c53356e3b36ac01f5308277ebe55d97c014af290966206e6f959393e1`.

## Scope

The component and actual adapter ran with installed canonical dependencies and controlled fetch responses. This continuation did not rerun the complete fee suite, RPC suite, application build, real-browser wallet flow or live Horizon request. No transaction, deployment, maintainer acceptance, award or payment is asserted. Earlier evidence remains bound to its own source in the existing fee documentation.
