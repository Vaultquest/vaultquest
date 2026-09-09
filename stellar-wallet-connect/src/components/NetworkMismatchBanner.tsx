import type { FC } from "react";
import { AlertTriangle } from "lucide-react";
import { useStore } from "@nanostores/react";
import { connectedNetwork as connectedNetworkStore } from "../core/store.js";
import { EXPECTED_NETWORK, STELLAR_NETWORKS, type NetworkType } from "../lib/wallets";

/**
 * Props for the NetworkMismatchBanner component.
 */
export interface NetworkMismatchBannerProps {
  expectedNetwork?: NetworkType;
  connectedNetwork?: NetworkType | null;
  actionName?: string;
  className?: string;
}

/**
 * Reusable banner alerting the user to a wallet network mismatch.
 * Displays the exact expected and actual networks along with recovery steps.
 */
export const NetworkMismatchBanner: FC<NetworkMismatchBannerProps> = ({
  expectedNetwork = EXPECTED_NETWORK,
  connectedNetwork,
  actionName = "Transactions",
  className = "",
}) => {
  const storeConnectedNetwork = useStore(connectedNetworkStore);
  const actual = connectedNetwork !== undefined ? connectedNetwork : storeConnectedNetwork;
  const expectedConfig = STELLAR_NETWORKS[expectedNetwork];
  const actualConfig = actual ? STELLAR_NETWORKS[actual] : null;

  const expectedDisplay = expectedConfig ? `${expectedConfig.displayName} (${expectedNetwork})` : expectedNetwork;
  const actualDisplay = actualConfig ? `${actualConfig.displayName} (${actual})` : (actual || "Unknown network");

  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid="network-mismatch-banner"
      className={`rounded-xl border border-red-500/40 bg-red-950/40 p-4 text-red-200 ${className}`}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" aria-hidden="true" />
        <div className="space-y-1">
          <p className="text-sm font-semibold text-white">Network Mismatch Detected</p>
          <p className="text-xs text-red-300">
            {actionName} are blocked. Your wallet is connected to{" "}
            <span className="font-semibold text-white" data-testid="actual-network">{actualDisplay}</span>
            , but this pool requires{" "}
            <span className="font-semibold text-white" data-testid="expected-network">{expectedDisplay}</span>.
          </p>
          <p className="text-xs text-red-400">
            Recovery: Switch your wallet network to{" "}
            <span className="font-semibold text-white">{expectedDisplay}</span> in your wallet settings to proceed.
          </p>
        </div>
      </div>
    </div>
  );
};

export default NetworkMismatchBanner;
