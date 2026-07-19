#!/usr/bin/env bash
# Cost-measurement runner for #27 and budget checks for #18.
#
# Runs the lifecycle harness with Soroban's built-in cost reporting and
# prints a one-block-per-test summary. Intended to be re-run any time
# storage layout, event payloads, or hot-path code changes — paste the
# resulting numbers into `docs/CONTRACT_COSTS.md` and explain the delta
# in "Recent changes".
#
# Usage:
#   ./scripts/measure_costs.sh           # runs cost check tests and verifies budgets
#   ./scripts/measure_costs.sh --raw     # full cargo output (for diffs)

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--raw" ]]; then
    exec cargo test --package drip-pool -- --nocapture --test-threads=1
fi

echo "Running Soroban Drip Pool Cost Budget Check..."
cargo test --package drip-pool test_cost_budgets -- --nocapture
