import { describe, it, expect, vi } from "vitest";
import { StrKey, Networks } from "@stellar/stellar-sdk";
import {
  IndexerConfigError,
  parseIndexerContractIds,
  validateIndexerConfig,
  toIndexerHealthMeta
} from "../src/services/indexerConfig.js";

function contractId(seed: number): string {
  const buf = Buffer.alloc(32, seed);
  return StrKey.encodeContract(buf);
}

function accountId(seed: number): string {
  const buf = Buffer.alloc(32, seed);
  return StrKey.encodeEd25519PublicKey(buf);
}

const C1 = contractId(1);
const C2 = contractId(2);
const G1 = accountId(3);

describe("parseIndexerContractIds", () => {
  it("accepts a valid contract set", () => {
    expect(parseIndexerContractIds(`${C1},${C2}`)).toEqual([C1, C2]);
  });

  it("trims mixed whitespace around IDs and commas", () => {
    expect(parseIndexerContractIds(`  ${C1} ,  ${C2}  , `)).toEqual([C1, C2]);
  });

  it("rejects malformed IDs", () => {
    expect(() => parseIndexerContractIds("not-a-contract")).toThrow(IndexerConfigError);
    expect(() => parseIndexerContractIds("not-a-contract")).toThrow(/Malformed contract ID/);
  });

  it("rejects account (G…) IDs as wrong key type", () => {
    expect(() => parseIndexerContractIds(G1)).toThrow(IndexerConfigError);
    expect(() => parseIndexerContractIds(G1)).toThrow(/wrong key type/);
  });

  it("rejects duplicates", () => {
    expect(() => parseIndexerContractIds(`${C1}, ${C1}`)).toThrow(/Duplicate contract ID/);
  });

  it("rejects empty / whitespace-only lists", () => {
    expect(() => parseIndexerContractIds("   ,  , ")).toThrow(/empty after trimming/);
  });
});

describe("validateIndexerConfig", () => {
  const testnet = Networks.TESTNET;
  const mainnet = Networks.PUBLIC;

  it("accepts a valid set when RPC network matches", async () => {
    const fetchNetwork = vi.fn(async () => ({
      passphrase: testnet,
      protocolVersion: "21"
    }));

    const config = await validateIndexerConfig({
      rpcUrl: "https://soroban-testnet.stellar.org",
      contractIdsRaw: ` ${C1}, ${C2} `,
      expectedNetworkPassphrase: testnet,
      fetchNetwork
    });

    expect(config.contractIds).toEqual([C1, C2]);
    expect(config.network.passphrase).toBe(testnet);
    expect(config.network.protocolVersion).toBe("21");
    expect(fetchNetwork).toHaveBeenCalledWith("https://soroban-testnet.stellar.org");
  });

  it.each([" Private VaultQuest network", "Private VaultQuest network "])(
    "preserves the exact matching passphrase %j in validation and health metadata",
    async (passphrase) => {
      const config = await validateIndexerConfig({
        rpcUrl: "https://soroban-private.example",
        contractIdsRaw: C1,
        expectedNetworkPassphrase: passphrase,
        fetchNetwork: async () => ({ passphrase, protocolVersion: "23" })
      });

      expect(config.network.passphrase).toBe(passphrase);
      expect(toIndexerHealthMeta(config).network?.passphrase).toBe(passphrase);
    }
  );

  it.each([" Private VaultQuest network", "Private VaultQuest network "])(
    "rejects a different RPC network obtained by trimming %j",
    async (passphrase) => {
      await expect(
        validateIndexerConfig({
          rpcUrl: "https://soroban-private.example",
          contractIdsRaw: C1,
          expectedNetworkPassphrase: passphrase,
          fetchNetwork: async () => ({
            passphrase: passphrase.trim(),
            protocolVersion: "23"
          })
        })
      ).rejects.toMatchObject({ code: "SOROBAN_RPC_NETWORK_MISMATCH" });
    }
  );

  it("still rejects whitespace-only passphrases before probing the RPC", async () => {
    const fetchNetwork = vi.fn(async () => ({
      passphrase: "   ",
      protocolVersion: "23"
    }));
    await expect(
      validateIndexerConfig({
        rpcUrl: "https://soroban-private.example",
        contractIdsRaw: C1,
        expectedNetworkPassphrase: "   ",
        fetchNetwork
      })
    ).rejects.toMatchObject({ code: "SOROBAN_NETWORK_PASSPHRASE_MISSING" });
    expect(fetchNetwork).not.toHaveBeenCalled();
  });

  it("rejects RPC network mismatch", async () => {
    await expect(
      validateIndexerConfig({
        rpcUrl: "https://soroban-mainnet.example",
        contractIdsRaw: C1,
        expectedNetworkPassphrase: testnet,
        fetchNetwork: async () => ({ passphrase: mainnet, protocolVersion: "21" })
      })
    ).rejects.toMatchObject({
      name: "IndexerConfigError",
      code: "SOROBAN_RPC_NETWORK_MISMATCH"
    });
  });

  it("rejects missing expected network passphrase", async () => {
    await expect(
      validateIndexerConfig({
        rpcUrl: "https://soroban-testnet.stellar.org",
        contractIdsRaw: C1,
        expectedNetworkPassphrase: undefined,
        fetchNetwork: async () => ({ passphrase: testnet, protocolVersion: "21" })
      })
    ).rejects.toMatchObject({ code: "SOROBAN_NETWORK_PASSPHRASE_MISSING" });
  });

  it("rejects when RPC identity probe fails", async () => {
    await expect(
      validateIndexerConfig({
        rpcUrl: "https://soroban-testnet.stellar.org",
        contractIdsRaw: C1,
        expectedNetworkPassphrase: testnet,
        fetchNetwork: async () => {
          throw new Error("connection refused");
        }
      })
    ).rejects.toMatchObject({ code: "SOROBAN_RPC_NETWORK_UNREACHABLE" });
  });

  it("surfaces validated network and contracts in health metadata", async () => {
    const config = await validateIndexerConfig({
      rpcUrl: "https://soroban-testnet.stellar.org",
      contractIdsRaw: C1,
      expectedNetworkPassphrase: testnet,
      fetchNetwork: async () => ({ passphrase: testnet, protocolVersion: "22" })
    });

    expect(toIndexerHealthMeta(config)).toEqual({
      configured: true,
      contract_ids: [C1],
      network: { passphrase: testnet, protocol_version: "22" }
    });
    expect(toIndexerHealthMeta(undefined)).toEqual({
      configured: false,
      contract_ids: [],
      network: null
    });
  });
});
