/**
 * Manipulation-resistant pricing subsystem (#71).
 *
 * See `docs/ORACLE.md` for the aggregation rule, circuit-breaker states,
 * conservative-price rule, and governance model.
 */
export * from "./types.js";
export * from "./aggregator.js";
export * from "./circuitBreaker.js";
export * from "./governance.js";
export * from "./metrics.js";
export * from "./oracleService.js";
export * from "./prometheusSink.js";
export * from "./testAdapter.js";
