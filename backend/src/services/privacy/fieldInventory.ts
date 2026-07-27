/**
 * Data Privacy & Personal Field Classification Inventory (issue #76).
 *
 * Categorizes database entities and fields by Sensitivity Level, Purpose,
 * Retention Period, Encryption Requirement, and Legal Hold rules.
 */

export type DataSensitivity = "PUBLIC" | "INTERNAL" | "SENSITIVE" | "RESTRICTED_PII";

export type DataPurpose =
  | "on_chain_ledger"
  | "user_preferences"
  | "quest_gamification"
  | "support_evidence"
  | "security_audit";

export interface FieldPrivacyDefinition {
  entity: string;
  field: string;
  sensitivity: DataSensitivity;
  purpose: DataPurpose;
  retentionDays: number | "indefinite";
  encryptAtRest: boolean;
  legalHoldApplies: boolean;
  onChainPublic: boolean;
}

export const DATA_PRIVACY_INVENTORY: Record<string, FieldPrivacyDefinition> = {
  "ActionLedger.actionPayload": {
    entity: "ActionLedger",
    field: "actionPayload",
    sensitivity: "SENSITIVE",
    purpose: "on_chain_ledger",
    retentionDays: 90,
    encryptAtRest: true,
    legalHoldApplies: true,
    onChainPublic: false,
  },
  "ActionLedger.errorDetail": {
    entity: "ActionLedger",
    field: "errorDetail",
    sensitivity: "INTERNAL",
    purpose: "on_chain_ledger",
    retentionDays: 30,
    encryptAtRest: false,
    legalHoldApplies: true,
    onChainPublic: false,
  },
  "UserNotificationPref.encryptedPref": {
    entity: "UserNotificationPref",
    field: "encryptedPref",
    sensitivity: "RESTRICTED_PII",
    purpose: "user_preferences",
    retentionDays: "indefinite",
    encryptAtRest: true,
    legalHoldApplies: false,
    onChainPublic: false,
  },
  "UserSupportEvidence.encryptedData": {
    entity: "UserSupportEvidence",
    field: "encryptedData",
    sensitivity: "RESTRICTED_PII",
    purpose: "support_evidence",
    retentionDays: 180,
    encryptAtRest: true,
    legalHoldApplies: true,
    onChainPublic: false,
  },
  "UserActivityLog.encryptedIp": {
    entity: "UserActivityLog",
    field: "encryptedIp",
    sensitivity: "RESTRICTED_PII",
    purpose: "security_audit",
    retentionDays: 90,
    encryptAtRest: true,
    legalHoldApplies: true,
    onChainPublic: false,
  },
  "UserActivityLog.encryptedMeta": {
    entity: "UserActivityLog",
    field: "encryptedMeta",
    sensitivity: "RESTRICTED_PII",
    purpose: "security_audit",
    retentionDays: 90,
    encryptAtRest: true,
    legalHoldApplies: true,
    onChainPublic: false,
  },
  "UserQuest.metadata": {
    entity: "UserQuest",
    field: "metadata",
    sensitivity: "SENSITIVE",
    purpose: "quest_gamification",
    retentionDays: 180,
    encryptAtRest: false,
    legalHoldApplies: true,
    onChainPublic: false,
  },
  "SavedPool.poolName": {
    entity: "SavedPool",
    field: "poolName",
    sensitivity: "INTERNAL",
    purpose: "user_preferences",
    retentionDays: "indefinite",
    encryptAtRest: false,
    legalHoldApplies: false,
    onChainPublic: false,
  },
};

/**
 * Helper to check if a specific entity field requires encryption at rest.
 */
export function requiresEncryption(entity: string, field: string): boolean {
  const key = `${entity}.${field}`;
  return DATA_PRIVACY_INVENTORY[key]?.encryptAtRest ?? false;
}
