import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { buildExportChallenge } from "../../src/middleware/export-auth.js";

/**
 * Generates real ed25519 wallets and real signatures, so the authorization
 * tests exercise the same verification path a live wallet would rather than a
 * stub that could agree with a broken implementation.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function crc16(data: Buffer): number {
  let crc = 0x0000;
  for (const byte of data) {
    let code = (crc >>> 8) & 0xff;
    code ^= byte & 0xff;
    code ^= code >>> 4;
    crc = (crc << 8) & 0xffff;
    crc ^= code;
    code = (code << 5) & 0xffff;
    crc ^= code;
    code = (code << 7) & 0xffff;
    crc ^= code;
  }
  return crc & 0xffff;
}

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Encodes a raw ed25519 public key as a Stellar `G...` address. */
function toStellarAddress(rawPublicKey: Buffer): string {
  const payload = Buffer.concat([Buffer.from([6 << 3]), rawPublicKey]);
  const checksum = Buffer.alloc(2);
  checksum.writeUInt16LE(crc16(payload));
  return base32Encode(Buffer.concat([payload, checksum]));
}

export interface TestWallet {
  address: string;
  privateKey: KeyObject;
  /** Signs the export challenge for this wallet at the given time. */
  sign(timestampMs: number): string;
  /** Signs an arbitrary message, for tests that tamper with the challenge. */
  signMessage(message: string): string;
  /** Ready-to-use auth headers for an export request. */
  authHeaders(timestampMs?: number): Record<string, string>;
}

export function createTestWallet(): TestWallet {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // Strip the 12-byte DER SPKI prefix to get the raw 32-byte key.
  const rawPublicKey = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const address = toStellarAddress(rawPublicKey);

  const signMessage = (message: string) =>
    sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64");

  return {
    address,
    privateKey,
    signMessage,
    sign: (timestampMs: number) => signMessage(buildExportChallenge(address, timestampMs)),
    authHeaders(timestampMs = Date.now()) {
      return {
        "x-wallet-address": address,
        "x-wallet-timestamp": String(timestampMs),
        "x-wallet-signature": signMessage(buildExportChallenge(address, timestampMs))
      };
    }
  };
}
