import { Contract, xdr } from "@stellar/stellar-sdk";

/**
 * Build the live contract-instance ledger key and extract its executable hash.
 * Kept with the wallet package, which already owns the Stellar SDK dependency.
 */
export function contractInstanceLedgerKey(contractId: string): string {
  return new Contract(contractId).getFootprint().toXDR("base64");
}

export function wasmHashFromContractInstance(entryXdr: string): string {
  const entry = xdr.LedgerEntryData.fromXDR(entryXdr, "base64");
  const hash = entry.contractData().val().instance().executable().wasmHash();
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
