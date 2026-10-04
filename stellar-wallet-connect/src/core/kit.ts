import {
  StellarWalletsKit,
  Networks as WalletNetwork,
} from "@creit.tech/stellar-wallets-kit";
import { FreighterModule } from "@creit.tech/stellar-wallets-kit/modules/freighter";
import { AlbedoModule } from "@creit.tech/stellar-wallets-kit/modules/albedo";
import { xBullModule } from "@creit.tech/stellar-wallets-kit/modules/xbull";
import { HanaModule } from "@creit.tech/stellar-wallets-kit/modules/hana";
import { RabetModule } from "@creit.tech/stellar-wallets-kit/modules/rabet";
import { LobstrModule } from "@creit.tech/stellar-wallets-kit/modules/lobstr";
import { LedgerModule } from "@creit.tech/stellar-wallets-kit/modules/ledger";
import { getFrontendEnv } from "./env.js";

// Re-exported for the wallet layer (#rate-limits): the Horizon connection pool
// balances on-chain reads across the nodes resolved here. The implementation
// lives in horizonPool.ts to keep it free of the wallets-kit dependency.
export { resolveHorizonNodes } from "./horizonPool.js";

const resolveWalletNetwork = (networkPassphrase?: string): WalletNetwork => {
  const env = getFrontendEnv();
  const configuredNetwork =
    networkPassphrase || env.NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE;

  switch (configuredNetwork) {
    case WalletNetwork.PUBLIC:
      return WalletNetwork.PUBLIC;
    case WalletNetwork.FUTURENET:
      return WalletNetwork.FUTURENET;
    case WalletNetwork.SANDBOX:
      return WalletNetwork.SANDBOX;
    case WalletNetwork.STANDALONE:
      return WalletNetwork.STANDALONE;
    case WalletNetwork.TESTNET:
    default:
      return WalletNetwork.TESTNET;
  }
};

export const createKit = (networkPassphrase?: string) => {
  StellarWalletsKit.init({
    modules: [
      new FreighterModule(),
      new AlbedoModule(),
      new xBullModule(),
      new HanaModule(),
      new RabetModule(),
      new LobstrModule(),
      new LedgerModule(),
    ],
    network: resolveWalletNetwork(networkPassphrase),
  });
  return StellarWalletsKit;
};

// Lazily initialize the kit's static API only when accessed in the browser.
let _kit: typeof StellarWalletsKit | undefined;

export const kit = new Proxy({} as typeof StellarWalletsKit, {
  get(_, prop) {
    if (typeof window === "undefined") {
      return undefined;
    }
    if (!_kit) {
      _kit = createKit();
    }
    const value = Reflect.get(_kit, prop);
    return typeof value === "function" ? value.bind(_kit) : value;
  },
});
