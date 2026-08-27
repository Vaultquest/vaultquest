/**
 * Real Soroban-backed {@link VaultContractClient} (Vaultquest/vaultquest#122).
 *
 * `submitAction` is the one method the UI depends on to be genuinely real: it
 * builds the pool contract invocation, simulates it, requests a wallet
 * signature through the shared `kit`, submits, and polls the RPC for finality
 * before resolving. Nothing here reports success ahead of an on-chain result.
 *
 * Reads proxy to the backend (`VaultApiClient`) where an endpoint exists, and
 * fall back to a direct read-only contract simulation for `getUserPosition`,
 * which has no backend endpoint. See `../README.md` for the client seam this
 * implements.
 */

import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc,
} from "@stellar/stellar-sdk";
import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import { getAssetDecimals } from "../../lib/assets";
import type { NetworkType } from "../../lib/wallets";
import { connectedPublicKey, networkReadiness } from "../../core/store";
import { VaultApiClient } from "../data/apiClient";
import {
  ContractInterfaceError,
  type PoolActionInput,
  type PoolActionResult,
  type PoolActionType,
  type PoolSummary,
  type RewardHistoryEntry,
  type UserPosition,
  type VaultContractClient,
} from "./types";

export interface SorobanVaultClientConfig {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  network: NetworkType;
  apiBaseUrl?: string;
  /** Milliseconds between finality polls. Defaults to 1500. */
  pollIntervalMs?: number;
  /** Total time budget for polling before giving up. Defaults to 30000. */
  pollTimeoutMs?: number;
}

/** Contract function each supported action type maps to (#122 scope note: `create`/`claim` have no contract-side entry point yet). */
const ACTION_FN: Partial<Record<PoolActionType, "deposit" | "withdraw">> = {
  join: "deposit",
  drip: "deposit",
  withdraw: "withdraw",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createSorobanVaultClient(config: SorobanVaultClientConfig): VaultContractClient {
  const api = new VaultApiClient(config.apiBaseUrl ?? "/api");
  const server = new rpc.Server(config.rpcUrl);
  const pollIntervalMs = config.pollIntervalMs ?? 1_500;
  const pollTimeoutMs = config.pollTimeoutMs ?? 30_000;

  const requireConnected = (): string => {
    const address = connectedPublicKey.get();
    if (!address) {
      throw new ContractInterfaceError("wallet_disconnected", "Connect a wallet to continue.");
    }
    if (networkReadiness.get() !== "verified") {
      throw new ContractInterfaceError(
        "wallet_disconnected",
        "Wallet network could not be verified. Reconnect and try again.",
      );
    }
    return address;
  };

  async function readUserBalance(depositor: string): Promise<bigint> {
    const contract = new Contract(config.contractId);
    const account = new Account(depositor, "0");
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(contract.call("balance_of", Address.fromString(depositor).toScVal()))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new ContractInterfaceError("contract_error", sim.error);
    }
    const result = sim.result?.retval;
    return result ? BigInt(scValToNative(result)) : 0n;
  }

  return {
    isWalletConnected: () => Boolean(connectedPublicKey.get()),
    getConnectedAddress: () => connectedPublicKey.get() || null,

    async getPool(poolId: string): Promise<PoolSummary> {
      const pools = await api.listPools();
      const pool = pools.find((p) => p.id === poolId);
      if (!pool) {
        throw new ContractInterfaceError("contract_error", `pool ${poolId} not found`);
      }
      return pool;
    },

    async listPools(): Promise<PoolSummary[]> {
      return api.listPools();
    },

    async getUserPosition(_poolId: string, walletAddress?: string): Promise<UserPosition | null> {
      const address = walletAddress || connectedPublicKey.get();
      if (!address) return null;
      const decimals = getAssetDecimals(config.network, "USDC");
      const balanceStroops = await readUserBalance(address);
      const deposited = (Number(balanceStroops) / 10 ** decimals).toString();
      return {
        walletAddress: address,
        deposited,
        shares: deposited,
        joined: balanceStroops > 0n,
      };
    },

    async listRewardHistory(walletAddress: string): Promise<RewardHistoryEntry[]> {
      return api.listPrizeViews(walletAddress);
    },

    async submitAction(type: PoolActionType, input: PoolActionInput): Promise<PoolActionResult> {
      const depositor = requireConnected();
      const fn = ACTION_FN[type];
      if (!fn) {
        throw new ContractInterfaceError("contract_error", `${type} is not supported by this pool`);
      }
      if (input.amount === undefined) {
        throw new ContractInterfaceError("contract_error", `${type} requires an amount`);
      }

      const decimals = getAssetDecimals(config.network, "USDC");
      const amountStroops = BigInt(Math.round(Number(input.amount) * 10 ** decimals));

      let prepared;
      try {
        const account = await server.getAccount(depositor);
        const contract = new Contract(config.contractId);
        const tx = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: config.networkPassphrase,
        })
          .addOperation(
            contract.call(
              fn,
              Address.fromString(depositor).toScVal(),
              nativeToScVal(amountStroops, { type: "i128" }),
            ),
          )
          .setTimeout(30)
          .build();
        prepared = await server.prepareTransaction(tx);
      } catch (err) {
        throw new ContractInterfaceError(
          "contract_error",
          err instanceof Error ? err.message : "Simulation failed",
        );
      }

      let signedTxXdr: string;
      try {
        const signResult = await StellarWalletsKit.signTransaction(prepared.toXDR(), {
          address: depositor,
          networkPassphrase: config.networkPassphrase,
        });
        signedTxXdr = signResult.signedTxXdr;
      } catch (err) {
        throw new ContractInterfaceError(
          "signature_rejected",
          err instanceof Error ? err.message : "Signature request was rejected",
        );
      }

      let sendResponse;
      try {
        const signedTx = TransactionBuilder.fromXDR(signedTxXdr, config.networkPassphrase);
        sendResponse = await server.sendTransaction(signedTx);
      } catch (err) {
        throw new ContractInterfaceError(
          "rpc_failure",
          err instanceof Error ? err.message : "Submission failed",
        );
      }

      if (sendResponse.status === "ERROR") {
        throw new ContractInterfaceError("rpc_failure", "The network rejected the transaction");
      }

      // Poll finality: keep asking the RPC for this hash's result until it
      // leaves NOT_FOUND, bounded by pollTimeoutMs. This is the real
      // confirmation the broken UI never had — no fixed-delay stand-in.
      const deadline = Date.now() + pollTimeoutMs;
      let status = await server.getTransaction(sendResponse.hash);
      while (status.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
        if (Date.now() > deadline) {
          throw new ContractInterfaceError("rpc_failure", "Confirmation timed out");
        }
        await sleep(pollIntervalMs);
        status = await server.getTransaction(sendResponse.hash);
      }

      if (status.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
        throw new ContractInterfaceError("contract_error", "Transaction failed on-chain");
      }

      return { txHash: sendResponse.hash, status: "submitted" };
    },
  };
}
