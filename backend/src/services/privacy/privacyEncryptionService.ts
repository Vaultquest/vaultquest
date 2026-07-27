import { createCipheriv, createDecipheriv, randomBytes, createHmac } from "node:crypto";

export interface EncryptedPayload {
  v: number;
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}

export class PrivacyEncryptionService {
  private readonly masterKey: Buffer;
  private currentKeyVersion = 1;

  constructor(masterKeySecret?: string, initialVersion = 1) {
    const rawKey = masterKeySecret || "default_vaultquest_privacy_master_secret_key_32bytes!!";
    // Derive a fixed 32-byte master key
    this.masterKey = createHmac("sha256", "vaultquest_master_salt").update(rawKey).digest();
    this.currentKeyVersion = initialVersion;
  }

  /**
   * Derive per-user envelope DEK (Data Encryption Key) based on wallet address and key version.
   */
  private deriveUserKey(walletAddress: string, version: number): Buffer {
    const info = `vaultquest-user-dek:${walletAddress.toLowerCase()}:v${version}`;
    return createHmac("sha256", this.masterKey).update(info).digest();
  }

  getCurrentKeyVersion(): number {
    return this.currentKeyVersion;
  }

  setCurrentKeyVersion(version: number): void {
    if (version < 1) throw new Error("Key version must be positive");
    this.currentKeyVersion = version;
  }

  /**
   * Encrypts plaintext or JSON object using AES-256-GCM and per-user DEK.
   */
  encrypt(walletAddress: string, data: unknown, keyVersion?: number): EncryptedPayload {
    const version = keyVersion ?? this.currentKeyVersion;
    const dek = this.deriveUserKey(walletAddress, version);
    const iv = randomBytes(12);

    const plaintext = typeof data === "string" ? data : JSON.stringify(data);

    const cipher = createCipheriv("aes-256-gcm", dek, iv);
    let ciphertext = cipher.update(plaintext, "utf8", "hex");
    ciphertext += cipher.final("hex");

    const tag = cipher.getAuthTag().toString("hex");

    return {
      v: version,
      alg: "aes-256-gcm",
      iv: iv.toString("hex"),
      tag,
      ciphertext,
    };
  }

  /**
   * Decrypts AES-256-GCM ciphertext payload back to parsed JS object or string.
   */
  decrypt<T = unknown>(walletAddress: string, payload: EncryptedPayload): T {
    if (!payload || !payload.ciphertext || !payload.iv || !payload.tag) {
      throw new Error("Invalid encrypted payload structure");
    }

    const dek = this.deriveUserKey(walletAddress, payload.v || 1);
    const iv = Buffer.from(payload.iv, "hex");
    const tag = Buffer.from(payload.tag, "hex");

    const decipher = createDecipheriv("aes-256-gcm", dek, iv);
    decipher.setAuthTag(tag);

    let plaintext = decipher.update(payload.ciphertext, "hex", "utf8");
    plaintext += decipher.final("utf8");

    try {
      return JSON.parse(plaintext) as T;
    } catch {
      return plaintext as unknown as T;
    }
  }

  /**
   * Re-encrypts payload to target key version for zero-downtime key rotation.
   */
  reencrypt(
    walletAddress: string,
    payload: EncryptedPayload,
    targetVersion: number
  ): EncryptedPayload {
    if (payload.v === targetVersion) return payload;
    const decrypted = this.decrypt(walletAddress, payload);
    return this.encrypt(walletAddress, decrypted, targetVersion);
  }
}
