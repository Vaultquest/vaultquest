# Manipulation-resistant pricing (#71)

Vault deposits, withdrawals, NAV, rewards, and risk decisions depend on asset
prices. A single stale or manipulated quote can mint excess shares, underpay
withdrawals, or hide insolvency. This subsystem sits between raw price feeds and
any value-changing operation. It refuses to let a single source, a stale
reading, or a divergent reading silently move value.

It lives in `backend/src/services/oracle/`. It defines **adapters and test
doubles only** — choosing production feed vendors is out of scope.

## Data model

Prices are integers scaled by `decimals`, never floats, because share math is
exact integer arithmetic and a rounding drift is real money.

An **observation** from one source carries: `price`, `decimals`, `sourceId`,
`asset` (symbol + contract + network), `observedAt`, `confidence`, and the
source's own `roundId`. The fully-qualified `asset` is what prevents
cross-network, wrong-asset, and decimal-confusion errors — every field is
matched exactly against the request.

An **aggregated price** is the immutable output of one round: the median
`price`, its canonical `decimals`, a fresh aggregate `roundId`, `asOf` and
`observationTime`, a `status`, the `contributingSources`, the `rejected`
observations with reasons, and the worst included `maxDeviationBps`. Every mint,
burn, and settlement binds itself to one of these by `roundId`.

## Aggregation rule (median / quorum)

`aggregate()` runs a fixed pipeline, recording why each source drops out:

1. **Asset identity** — wrong asset or wrong network is excluded, never priced.
2. **Decimal normalisation** — a reading is rescaled to the canonical scale.
   Scaling up is exact; scaling down is allowed only when it divides evenly.
   A reading that would lose precision is excluded as `DECIMAL_CONFUSION`
   rather than silently truncated.
3. **Sanity bounds** — non-positive and absurd (`>= maxPrice`) prices excluded.
4. **Freshness** — observations older than `maxStalenessMs` are excluded.
5. **Confidence** — readings below `minConfidence` are excluded.
6. **Quorum** — fewer than `minSources` survivors yields **no price**
   (`QUORUM_LOSS`), not a guess.
7. **Robust median** — the median of survivors is the reference; survivors that
   deviate beyond `maxDeviationBps` are dropped as outliers, then quorum is
   re-checked and the final median is taken over the inliers.

Consequences that satisfy the acceptance criteria:

- **No single source can determine price.** With a quorum of ≥ 3 and a robust
  median, one wild or malicious source is dropped as an outlier and cannot move
  the median. If enough sources diverge that the quorum breaks after dropping
  outliers, the result is `QUORUM_LOSS` — never a silently wrong price.
- **Stale or divergent data cannot silently execute.** Stale readings are
  excluded; a surviving deviation surfaces as `DEGRADED_DEVIATION`, which trips
  the breaker into conservative pricing.

Statuses: `OK`, `DEGRADED_DEVIATION` (priced, but a feed disagreed),
`QUORUM_LOSS` (too few trusted sources), `NO_DATA` (nothing usable).

## Circuit breaker

A three-state machine, worst-last:

| State | Meaning | Deposit | Withdraw | Valuation | Liquidation |
|---|---|---|---|---|---|
| `CLOSED` | normal | median | median | median | median |
| `DEGRADED` | sources disagreed, quorum held | conservative | conservative | conservative | **paused** |
| `OPEN` | no trustworthy price | **blocked** | emergency safe-exit | last-good | **blocked** |

Tripping is immediate: one bad round opens the breaker. Recovery is deliberate:
`recoveryThreshold` consecutive **strictly-improving** rounds are required to
step back one level, and any non-improving round resets that streak. This
hysteresis stops a flapping feed from oscillating the gate. An operator can
`forceState` from a runbook.

### Conservative-price rule

The haircut is applied in the solvency-protecting direction:

- **Deposit** prices assets **up** (`× (1 + haircut)`) → mints **fewer** shares,
  so a manipulated low price cannot mint excess shares.
- **Withdraw / liquidation** prices assets **down** (`× (1 - haircut)`) → pays
  out **less**, so a manipulated high price cannot drain the pool.
- **Valuation** reads the unadjusted median.

Both directions err against the actor and in favour of the holders who remain.

### Emergency safe-exit

When the breaker is `OPEN`, there is no trustworthy live price. Deposits and
liquidations are blocked — there is no safe way to take new money in or seize
collateral against a price you don't trust. **Withdrawals stay open** at a
conservative haircut off the last trustworthy snapshot, so holders can always
exit; the haircut protects remaining holders from a drain. If there is no
last-good snapshot at all, even withdrawal is blocked rather than guessing.

## Governance and reproducibility

Changing the source set is a value-relevant act — a compromised key that could
instantly swap in a malicious source would defeat the quorum. `SourceGovernance`
requires a **timelock**: `propose()` then `commit()` only after
`governanceTimelockMs` elapses, giving holders a window to react.

Every aggregation is stored in `SnapshotStore` keyed by `roundId`, with **both**
the output and its exact inputs and active source set. Historical NAV, rewards,
and settlement calculations are reproducible from a stored round id:
`OracleService.reproduce(roundId)` re-runs the stored inputs and returns the
recomputed price alongside the stored one; equal values prove determinism.
Rounds bound to a settlement are pinned and never evicted.

## Metrics and alerts

The service reports through an injected `OracleMetricsSink` (kept out of the
core so it stays pure). `PrometheusOracleSink` exposes:

- `oracle_aggregations_total{status}` and `oracle_max_deviation_bps`
- `oracle_rejected_total{reason}` — a rising count is a feed-quality alert
- `oracle_breaker_state` (0/1/2) and `oracle_breaker_transitions_total{from,to}`
- `oracle_source_failures_total{source}` — a source is hard-failing

`RecordingMetricsSink` is the test double and doubles as a lightweight alert
surface: `breakerTransitions` and `sourceFailures` are exactly what an on-call
rotation pages on.

## Tests

`backend/tests/oracle.spec.ts` covers the required scenarios: stale feeds, one
malicious source, quorum loss, decimals (scale up/down and confusion), zero /
negative / extreme price, cross-network and wrong-asset guards, rapid volatility
tripping and recovering the breaker, source rotation through governance,
concurrent updates binding distinct snapshots, historical reproducibility across
a source change, and the conservative-price / emergency-exit rules.
