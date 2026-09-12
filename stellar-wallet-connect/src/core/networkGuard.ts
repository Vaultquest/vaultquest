/**
 * Action gate for the wallet network (#178).
 *
 * Deposit, withdrawal and claim all reach the contract through
 * submitAction -> requireConnected(), which used to reject anything that was
 * not "verified" with a single code (wallet_disconnected) and a single message
 * ("Wallet network could not be verified"). Three problems with that:
 *
 * - a confirmed network mismatch was reported as if the wallet were not
 *   connected, which is the opposite of the truth and sends the user to
 *   reconnect a wallet that is already fine;
 * - the message never named the network the app expects or the one the wallet
 *   is actually on, so "switch networks" was advice the user could not act on;
 * - the transient "verifying" state that follows every connection looked
 *   identical to a real failure.
 *
 * This module is pure: it takes the store values as arguments so every branch is
 * testable without a wallet, and it returns the exact pair of networks along
 * with a message the UI can render as-is.
 */

import type { NetworkType } from "../lib/wallets.js";

/** Mirrors the networkReadiness atom in ./store. */
export type NetworkReadiness = "idle" | "verifying" | "verified" | "mismatch" | "error";

/** Codes that block an action. Each one is a valid ContractErrorKind. */
export type NetworkGateFailureCode =
  | "wallet_disconnected"
  | "network_mismatch"
  | "network_unverified"
  | "network_verification_failed";

export type NetworkGateCode = "ok" | NetworkGateFailureCode;

export interface NetworkGateInput {
  publicKey?: string | null;
  readiness: NetworkReadiness;
  /** Network the wallet reports, or null when it could not be read. */
  connectedNetwork?: NetworkType | null;
  /** Network the app is configured for (EXPECTED_NETWORK). */
  expectedNetwork: NetworkType;
}

/**
 * Discriminated on allowed, so a caller that checked the gate narrows the code
 * to a failure code. That is what lets the contract client hand the code to an
 * error constructor without a cast.
 */
export type NetworkGate =
  | {
      allowed: true;
      code: "ok";
      expectedNetwork: NetworkType;
      /** null when the wallet network is not known, never a guess. */
      actualNetwork: NetworkType | null;
      message: "";
    }
  | {
      allowed: false;
      code: NetworkGateFailureCode;
      expectedNetwork: NetworkType;
      /** null when the wallet network is not known, never a guess. */
      actualNetwork: NetworkType | null;
      message: string;
    };

/** Human-readable network name, for messages a person has to act on. */
export function networkLabel(network: NetworkType | null | undefined): string {
  switch (network) {
    case "mainnet":
      return "Mainnet";
    case "testnet":
      return "Testnet";
    case "futurenet":
      return "Futurenet";
    case "standalone":
      return "Standalone";
    default:
      return "an unknown network";
  }
}

/**
 * Decide whether a state-changing action may proceed, and say exactly why when
 * it may not.
 */
export function evaluateNetworkGate(input: NetworkGateInput): NetworkGate {
  const expectedNetwork = input.expectedNetwork;
  const expected = networkLabel(expectedNetwork);
  const actualNetwork = input.connectedNetwork ?? null;
  const actual = networkLabel(actualNetwork);

  if (!input.publicKey) {
    return {
      allowed: false,
      code: "wallet_disconnected",
      expectedNetwork,
      actualNetwork,
      message: "Connect a wallet to continue.",
    };
  }

  switch (input.readiness) {
    case "verified":
      return {
        allowed: true,
        code: "ok",
        expectedNetwork,
        actualNetwork,
        message: "",
      };

    case "mismatch":
      return {
        allowed: false,
        code: "network_mismatch",
        expectedNetwork,
        actualNetwork,
        message: actualNetwork
          ? "Your wallet is on " +
            actual +
            " but this app expects " +
            expected +
            ". Switch your wallet to " +
            expected +
            " to deposit, withdraw or claim."
          : "Your wallet's network could not be identified, and this app expects " +
            expected +
            ". Switch your wallet to " +
            expected +
            " to deposit, withdraw or claim.",
      };

    case "error":
      return {
        allowed: false,
        code: "network_verification_failed",
        expectedNetwork,
        actualNetwork,
        message:
          "Could not read your wallet's network. This app expects " +
          expected +
          ". Reconnect your wallet and try again.",
      };

    // "verifying" right after a connection, and "idle" with a key present, are
    // both "we do not know yet" - not "you are on the wrong network".
    default:
      return {
        allowed: false,
        code: "network_unverified",
        expectedNetwork,
        actualNetwork,
        message:
          "Still checking your wallet's network. This app expects " +
          expected +
          "; try again in a moment.",
      };
  }
}
