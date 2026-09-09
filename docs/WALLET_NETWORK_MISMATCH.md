# Wallet Network Mismatch Workflow

VaultQuest requires active pool operations to match the configured Stellar network (`testnet`). When a connected wallet reports a mismatched network (such as `mainnet` or `futurenet`), state-mutating actions must be blocked to prevent transaction failures, user confusion, and failed contract invocations.

## Summary of Protected Workflows

| Workflow | Blocking Mechanism | UI Indicator | Recovery Guidance |
| --- | --- | --- | --- |
| **Deposits** | `DepositModal.tsx` disables "Continue" and "Confirm deposit" buttons. Submissions reject with error. | Alert banner at the top of the modal (`NetworkMismatchBanner`) with `role="alert"` and `aria-live="assertive"`. | Displays expected network (`testnet`) vs connected network, directing user to switch networks in wallet settings. |
| **Withdrawals** | `WithdrawalModal.tsx` disables "Continue" and "Confirm withdrawal" buttons. `page.jsx` disables "Withdraw Principal". | Alert banner at the top of the modal (`NetworkMismatchBanner`) and disabled button tooltips. | Prompts wallet network switch to match pool target. |
| **Reward Claims** | `RewardHistory.tsx` disables desktop "Claim" and mobile "Claim reward" buttons. | Alert banner rendered above the history table and cards. | Directs user to change network to enable claiming won rewards. |

## Network State Detection

Detection relies on the centralized Nanostores state in `stellar-wallet-connect/src/core/store.js`:

- `isNetworkMismatch`: Boolean atom indicating whether `connectedNetwork !== EXPECTED_NETWORK`.
- `networkReadiness`: String atom reporting `"verified"` when ready, or `"mismatch"` when on an incorrect network.
- `connectedNetwork`: Atom tracking the active wallet network type (`"testnet"`, `"public"`, `"futurenet"`, or `null`).
- `EXPECTED_NETWORK`: Constant defined in `stellar-wallet-connect/src/lib/wallets.ts` (`"testnet"`).

Components accept both prop overrides (`isNetworkMismatch`, `connectedNetwork`, `expectedNetwork`) for standalone testability and react dynamically to store state changes.

## Reusable Component: `NetworkMismatchBanner`

The `NetworkMismatchBanner` component (`stellar-wallet-connect/src/components/NetworkMismatchBanner.tsx`) provides consistent alerting across modal and inline views:

- Accessible via `role="alert"` and `aria-live="assertive"`.
- Displays human-readable network labels (e.g., "Stellar Mainnet (mainnet)" vs "Stellar Testnet (testnet)").
- Accepts custom `actionName` prop to tailor messaging ("Deposits", "Withdrawals", "Reward claims").
- Highlights actionable recovery steps for wallet settings.

## Recovery Procedure

1. Open the connected Stellar wallet extension (Freighter, Lobstr, xBull, Hana).
2. Navigate to Network Settings.
3. Switch network to **Stellar Testnet**.
4. The reactive store automatically updates `isNetworkMismatch` to `false` and `networkReadiness` to `"verified"`.
5. The alert banner unmounts and transaction buttons re-enable without requiring a page reload.
