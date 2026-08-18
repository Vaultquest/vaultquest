import { atom } from "nanostores";
import type { NetworkType } from "../lib/wallets.js";

/**
 * Explicit lifecycle for network verification (issue #101).
 * - "idle": no wallet connected, nothing to verify.
 * - "verifying": a connection/restore was published but network verification
 *   has not resolved yet. Contract actions MUST be blocked in this state.
 * - "verified": verification succeeded and the connected network matches the
 *   expected network. Contract actions are allowed.
 * - "mismatch": verification succeeded but the connected network does not
 *   match the expected network.
 * - "error": verification failed (e.g. the wallet/provider could not report
 *   its network). Treated the same as "mismatch" for gating purposes, but
 *   surfaced separately so the UI can distinguish outage from wrong network.
 */
export type NetworkReadinessState = "idle" | "verifying" | "verified" | "mismatch" | "error";

export const connectedPublicKey = atom<string>("");
export const connectedNetwork = atom<NetworkType | null>(null);
export const isNetworkMismatch = atom<boolean>(false);
export const networkReadiness = atom<NetworkReadinessState>("idle");

