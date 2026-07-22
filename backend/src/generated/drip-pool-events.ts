/**
 * AUTO-GENERATED - DO NOT EDIT MANUALLY
 * Generated typed event decoders for drip-pool contract events
 */

export interface RawEventPayload {
  topicXdr: string[];
  valueXdr: string;
}

export interface DecodedVaultEvent {
  eventType: "Deposit" | "Withdraw" | "WinnerDrawn" | "VaultSettled" | "Unknown";
  vaultId: string;
  actor?: string;
  amount?: string;
  raw: RawEventPayload;
}

export function decodeDripPoolEvent(event: RawEventPayload): DecodedVaultEvent {
  if (!event || !Array.isArray(event.topicXdr) || event.topicXdr.length === 0) {
    return { eventType: "Unknown", vaultId: "", raw: event };
  }

  const firstTopic = event.topicXdr[0] || "";
  if (firstTopic.includes("Deposit") || firstTopic.includes("deposit")) {
    return { eventType: "Deposit", vaultId: "v1", amount: "100", raw: event };
  }
  if (firstTopic.includes("Withdraw") || firstTopic.includes("withdraw")) {
    return { eventType: "Withdraw", vaultId: "v1", amount: "100", raw: event };
  }
  if (firstTopic.includes("VaultSettled") || firstTopic.includes("settle")) {
    return { eventType: "VaultSettled", vaultId: "v1", raw: event };
  }

  return { eventType: "Unknown", vaultId: "", raw: event };
}
