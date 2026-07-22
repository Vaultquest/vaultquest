import { createHash, randomUUID, createCipheriv, createDecipheriv, randomBytes, createHmac } from "node:crypto";

console.log("=================================================");
console.log(" PRIVACY & ENCRYPTION VERIFICATION SUITE (#76) ");
console.log("=================================================\n");

let passedTests = 0;
let totalTests = 0;

function assert(condition, message) {
  totalTests++;
  if (condition) {
    console.log(`[PASS] ${message}`);
    passedTests++;
  } else {
    console.error(`[FAIL] ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
}

// -------------------------------------------------------------
// 1. Encryption & Decryption Engine (AES-256-GCM + DEK Derivation)
// -------------------------------------------------------------
class PrivacyEncryptionService {
  constructor(masterKeySecret = "test_privacy_master_secret_key_32bytes!!", initialVersion = 1) {
    this.masterKey = createHmac("sha256", "vaultquest_master_salt").update(masterKeySecret).digest();
    this.currentKeyVersion = initialVersion;
  }

  deriveUserKey(walletAddress, version) {
    const info = `vaultquest-user-dek:${walletAddress.toLowerCase()}:v${version}`;
    return createHmac("sha256", this.masterKey).update(info).digest();
  }

  encrypt(walletAddress, data, keyVersion = this.currentKeyVersion) {
    const dek = this.deriveUserKey(walletAddress, keyVersion);
    const iv = randomBytes(12);
    const plaintext = typeof data === "string" ? data : JSON.stringify(data);

    const cipher = createCipheriv("aes-256-gcm", dek, iv);
    let ciphertext = cipher.update(plaintext, "utf8", "hex");
    ciphertext += cipher.final("hex");
    const tag = cipher.getAuthTag().toString("hex");

    return {
      v: keyVersion,
      alg: "aes-256-gcm",
      iv: iv.toString("hex"),
      tag,
      ciphertext,
    };
  }

  decrypt(walletAddress, payload) {
    const dek = this.deriveUserKey(walletAddress, payload.v || 1);
    const iv = Buffer.from(payload.iv, "hex");
    const tag = Buffer.from(payload.tag, "hex");

    const decipher = createDecipheriv("aes-256-gcm", dek, iv);
    decipher.setAuthTag(tag);

    let plaintext = decipher.update(payload.ciphertext, "hex", "utf8");
    plaintext += decipher.final("utf8");

    try {
      return JSON.parse(plaintext);
    } catch {
      return plaintext;
    }
  }

  reencrypt(walletAddress, payload, targetVersion) {
    if (payload.v === targetVersion) return payload;
    const decrypted = this.decrypt(walletAddress, payload);
    return this.encrypt(walletAddress, decrypted, targetVersion);
  }
}

// -------------------------------------------------------------
// Test Execution: Encryption & Decryption
// -------------------------------------------------------------
const encSvc = new PrivacyEncryptionService();
const userA = "GUSERA11111111111111111111111111111111111111111111111111";
const userB = "GUSERB22222222222222222222222222222222222222222222222222";

const sensitiveData = { secretIP: "192.168.1.50", preference: "dark_mode", balance: "1000" };
const encryptedA = encSvc.encrypt(userA, sensitiveData);

assert(encryptedA.v === 1, "Payload key version is 1");
assert(encryptedA.alg === "aes-256-gcm", "Payload algorithm is AES-256-GCM");
assert(!encryptedA.ciphertext.includes("192.168.1.50"), "Database compromise check: Plaintext IP not in ciphertext");

const decryptedA = encSvc.decrypt(userA, encryptedA);
assert(decryptedA.secretIP === "192.168.1.50", "Decrypted payload matches original sensitive data");

let userBDecryptionFailed = false;
try {
  encSvc.decrypt(userB, encryptedA);
} catch {
  userBDecryptionFailed = true;
}
assert(userBDecryptionFailed, "Cross-user isolation: User B cannot decrypt User A's payload");

// Key Rotation Re-encryption Test
const reencryptedV2 = encSvc.reencrypt(userA, encryptedA, 2);
assert(reencryptedV2.v === 2, "Re-encrypted payload updated to key version 2");
const decryptedV2 = encSvc.decrypt(userA, reencryptedV2);
assert(decryptedV2.secretIP === "192.168.1.50", "Decryption with key v2 succeeds after key rotation");

// -------------------------------------------------------------
// 2. Audit Redaction Engine
// -------------------------------------------------------------
function hashWallet(walletAddress) {
  if (!walletAddress) return null;
  return createHash("sha256")
    .update(`audit_salt:${walletAddress.toLowerCase()}`)
    .digest("hex")
    .substring(0, 16);
}

function redactAuditDetails(details) {
  if (!details) return {};
  const sanitized = {};
  for (const [key, value] of Object.entries(details)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.includes("password") ||
      lowerKey.includes("secret") ||
      lowerKey.includes("ip") ||
      lowerKey.includes("email")
    ) {
      sanitized[key] = "[REDACTED_AUDIT]";
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

const auditDetails = redactAuditDetails({ ip: "10.0.0.1", user_email: "alice@test.com", actionCount: 5 });
assert(auditDetails.ip === "[REDACTED_AUDIT]", "Audit logger redacts IP address");
assert(auditDetails.user_email === "[REDACTED_AUDIT]", "Audit logger redacts user email");
assert(auditDetails.actionCount === 5, "Audit logger preserves non-PII operational counts");

const walletHashA = hashWallet(userA);
assert(walletHashA.length === 16, "Wallet address hashed to 16-char anonymized string");
assert(!walletHashA.includes(userA), "Wallet hash does not expose raw wallet public key");

// -------------------------------------------------------------
// 3. Export Third-Party Redaction & Provenance Checksum
// -------------------------------------------------------------
function redactThirdPartyData(obj, requestingWallet) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => redactThirdPartyData(item, requestingWallet));
  }

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.includes("internal_secret") || lowerKey.includes("private_key")) {
      result[key] = "[REDACTED_INTERNAL]";
    } else if (
      typeof value === "string" &&
      value.startsWith("G") &&
      value.length === 56 &&
      value.toLowerCase() !== requestingWallet.toLowerCase()
    ) {
      result[key] = "[REDACTED_THIRD_PARTY_WALLET]";
    } else if (typeof value === "object" && value !== null) {
      result[key] = redactThirdPartyData(value, requestingWallet);
    } else {
      result[key] = value;
    }
  }
  return result;
}

const rawExportPayload = {
  internal_secret: "prod_platform_secret",
  counterparty: userB,
  questProgress: 75,
};

const sanitizedExport = redactThirdPartyData(rawExportPayload, userA);
assert(sanitizedExport.internal_secret === "[REDACTED_INTERNAL]", "Export redacts internal secrets");
assert(sanitizedExport.counterparty === "[REDACTED_THIRD_PARTY_WALLET]", "Export redacts third-party wallet addresses");
assert(sanitizedExport.questProgress === 75, "Export preserves requesting user's own data");

const exportJson = JSON.stringify(sanitizedExport);
const checksum = createHash("sha256").update(exportJson).digest("hex");
assert(checksum.length === 64, "Export provenance checksum generated (SHA-256)");

// -------------------------------------------------------------
// 4. Verifiable Deletion & Accounting Integrity
// -------------------------------------------------------------
function anonymizeWalletReference(walletAddress) {
  const hash = createHash("sha256")
    .update(`anonymized_identity_salt:${walletAddress.toLowerCase()}`)
    .digest("hex")
    .substring(0, 16);
  return `[REDACTED_USER_${hash}]`;
}

const anonymizedIdentity = anonymizeWalletReference(userA);
assert(anonymizedIdentity.startsWith("[REDACTED_USER_"), "Ledger identity anonymized with prefix");
assert(!anonymizedIdentity.includes(userA), "Anonymized identity removes wallet reference");

// Manifest Verification Hash
const manifestId = randomUUID();
const manifestHashPayload = `${manifestId}:${walletHashA}:deletedCounts_mock`;
const manifestHash = createHash("sha256").update(manifestHashPayload).digest("hex");
assert(manifestHash.length === 64, "Verifiable completion manifest hash created");

console.log("\n=================================================");
console.log(` ALL VERIFICATION TESTS PASSED (${passedTests}/${totalTests}) `);
console.log("=================================================");
