/**
 * Validates indexer contract IDs and Soroban RPC network alignment (issue #133).
 *
 * Malformed IDs, wrong key types, duplicates, or a network passphrase mismatch
 * must fail closed before the indexer worker starts.
 */

import { StrKey, rpc } from "@stellar/stellar-sdk";

export class IndexerConfigError extends Error {
  readonly code: string;

  constructor(message: string, code = "INDEXER_CONFIG_INVALID") {
    super(message);
    this.name = "IndexerConfigError";
    this.code = code;
  }
}

export type NetworkIdentity = {
  passphrase: string;
  protocolVersion: string;
};

export type ValidatedIndexerConfig = {
  rpcUrl: string;
  contractIds: string[];
  network: NetworkIdentity;
};

export type FetchNetworkFn = (rpcUrl: string) => Promise<NetworkIdentity>;

/**
 * Split a comma-separated INDEXER_CONTRACT_IDS value, trim whitespace, and
 * StrKey-decode every entry as a contract (`C…`) ID. Rejects empties,
 * duplicates, account (`G…`) keys, and other malformed StrKeys.
 */
export function parseIndexerContractIds(raw: string): string[] {
  if (typeof raw !== "string") {
    throw new IndexerConfigError("INDEXER_CONTRACT_IDS must be a string");
  }

  const parts = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new IndexerConfigError(
      "INDEXER_CONTRACT_IDS is empty after trimming",
      "INDEXER_CONTRACT_IDS_EMPTY"
    );
  }

  const seen = new Set<string>();
  const contractIds: string[] = [];

  for (const id of parts) {
    if (seen.has(id)) {
      throw new IndexerConfigError(
        `Duplicate contract ID: ${id}`,
        "INDEXER_CONTRACT_ID_DUPLICATE"
      );
    }
    seen.add(id);

    if (StrKey.isValidEd25519PublicKey(id)) {
      throw new IndexerConfigError(
        `Contract ID has wrong key type (account/public key): ${id}`,
        "INDEXER_CONTRACT_ID_WRONG_TYPE"
      );
    }

    let decoded: Buffer;
    try {
      decoded = StrKey.decodeContract(id);
    } catch {
      throw new IndexerConfigError(
        `Malformed contract ID (StrKey decode failed): ${id}`,
        "INDEXER_CONTRACT_ID_MALFORMED"
      );
    }

    if (!decoded || decoded.length !== 32 || !StrKey.isValidContract(id)) {
      throw new IndexerConfigError(
        `Malformed contract ID: ${id}`,
        "INDEXER_CONTRACT_ID_MALFORMED"
      );
    }

    contractIds.push(id);
  }

  return contractIds;
}

/** Production RPC identity probe via Soroban `getNetwork`. */
export async function fetchSorobanNetwork(rpcUrl: string): Promise<NetworkIdentity> {
  const allowHttp = rpcUrl.startsWith("http://");
  const server = new rpc.Server(rpcUrl, { allowHttp });
  const network = await server.getNetwork();
  return {
    passphrase: network.passphrase,
    protocolVersion: String(network.protocolVersion)
  };
}

export type ValidateIndexerConfigInput = {
  rpcUrl: string;
  contractIdsRaw: string;
  expectedNetworkPassphrase: string | undefined;
  fetchNetwork?: FetchNetworkFn;
};

/**
 * Fully validate indexer startup config: contract StrKeys + RPC network
 * passphrase alignment. Throws IndexerConfigError on any failure.
 */
export async function validateIndexerConfig(
  input: ValidateIndexerConfigInput
): Promise<ValidatedIndexerConfig> {
  // Network identity includes the full passphrase; trim only to reject blanks.
  const expected = input.expectedNetworkPassphrase;
  if (!expected?.trim()) {
    throw new IndexerConfigError(
      "SOROBAN_NETWORK_PASSPHRASE is required when the indexer is enabled",
      "SOROBAN_NETWORK_PASSPHRASE_MISSING"
    );
  }

  const contractIds = parseIndexerContractIds(input.contractIdsRaw);
  const fetchNetwork = input.fetchNetwork ?? fetchSorobanNetwork;

  let network: NetworkIdentity;
  try {
    network = await fetchNetwork(input.rpcUrl);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new IndexerConfigError(
      `Failed to resolve Soroban RPC network identity: ${detail}`,
      "SOROBAN_RPC_NETWORK_UNREACHABLE"
    );
  }

  if (network.passphrase !== expected) {
    throw new IndexerConfigError(
      `Soroban RPC network mismatch: expected passphrase ${JSON.stringify(expected)}, got ${JSON.stringify(network.passphrase)}`,
      "SOROBAN_RPC_NETWORK_MISMATCH"
    );
  }

  return {
    rpcUrl: input.rpcUrl,
    contractIds,
    network
  };
}

export type IndexerHealthMeta = {
  configured: boolean;
  contract_ids: string[];
  network: {
    passphrase: string;
    protocol_version: string;
  } | null;
};

export function toIndexerHealthMeta(
  config: ValidatedIndexerConfig | undefined
): IndexerHealthMeta {
  if (!config) {
    return { configured: false, contract_ids: [], network: null };
  }
  return {
    configured: true,
    contract_ids: [...config.contractIds],
    network: {
      passphrase: config.network.passphrase,
      protocol_version: config.network.protocolVersion
    }
  };
}
