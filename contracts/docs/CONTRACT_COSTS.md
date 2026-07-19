# Drip Pool — Cost Profile & Budget Enforcement (#18, #27)

This document tracks the execution costs and enforces the resource budgets for the VaultQuest Soroban smart contracts.

---

## 🚀 Cost Budget Enforcement in CI

To prevent cost regressions on hot paths, we enforce CPU instruction and memory consumption budgets in our continuous integration (CI) pipeline.

*   **Threshold Config File**: [`contracts/drip-pool/cost_thresholds.txt`](../drip-pool/cost_thresholds.txt)
*   **Cost Check Script**: [`contracts/scripts/measure_costs.sh`](../scripts/measure_costs.sh)
*   **CI Trigger**: Every pull request targeting the `main` or `develop` branches that modifies contract source code runs the budget checks. If any operation exceeds its configured threshold, the CI pipeline fails.

---

## 💻 Running Budget Checks Locally

Developers must run budget checks locally before submitting a pull request:

```bash
cd contracts/
./scripts/measure_costs.sh
```

To run a raw cargo test with full standard out captures:

```bash
./scripts/measure_costs.sh --raw
```

---

## 📊 Measured Baselines & Thresholds

Below are the resource usage statistics measured in the native Rust test environment.

| Operation | CPU Instructions (Baseline) | CPU Threshold | Memory (Baseline) | Memory Threshold | Notes |
|---|---|---|---|---|---|
| `create(admin)` | 76,551 | 100,000 | 7,877 bytes | 10,000 bytes | Configures initial pool metadata and admin signers. |
| `join(who)` | 59,535 | 80,000 | 9,848 bytes | 12,000 bytes | Initializes participant record and locks period. |
| `deposit(who, amount)` | 116,829 | 150,000 | 17,708 bytes | 22,000 bytes | Increments user balance and total deposits. |
| `drip(who, amount)` | 117,921 | 150,000 | 18,098 bytes | 22,000 bytes | Evaluates yield, performs drips. Hot path. |
| `draw_winner(prize)` | 63,743 | 85,000 | 9,058 bytes | 12,000 bytes | Selects pool winners (admin-only). |
| `claim(who)` | 75,346 | 100,000 | 12,336 bytes | 16,000 bytes | Resets user claimable rewards to zero. |
| `withdraw(who)` | 121,849 | 150,000 | 17,753 bytes | 22,000 bytes | Reentrancy-guarded withdrawal of principal. |
| `propose(action)` | 102,145 | 130,000 | 16,092 bytes | 20,000 bytes | Proposes admin multi-sig actions. |
| `approve(id)` | 142,512 | 180,000 | 23,792 bytes | 30,000 bytes | Approves and auto-executes proposals. |

---

## 🔧 Updating Budgets for Intentional Changes

If you intentionally introduce features that increase the cost complexity of an operation (e.g. adding new validation rules, storage writes, or events):

1.  Measure the new baseline costs by running:
    ```bash
    ./scripts/measure_costs.sh
    ```
2.  Review the output cost profile.
3.  Open [`contracts/drip-pool/cost_thresholds.txt`](../drip-pool/cost_thresholds.txt) and adjust the threshold keys for the affected operations (it is recommended to set thresholds ~15-20% above your new baselines to prevent flaky test failures).
4.  Commit the updated `cost_thresholds.txt` along with your contract changes and a brief justification in the pull request description.
