import { createPublicKey, verify as cryptoVerify } from "node:crypto";

/**
 * Minimal StrKey decoding and ed25519 signature verification.
 *
 * A Stellar `G...` address is a base32-encoded ed25519 public key, and Node's
 * crypto already verifies ed25519, so this needs no Stellar SDK dependency on
 * the backend for the one thing we use it for.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Version byte for an ed25519 public key, which is what renders as a leading "G". */
const VERSION_BYTE_ED25519_PUBLIC_KEY = 6 << 3;

/** 1 version byte + 32-byte payload + 2 checksum bytes. */
const DECODED_LENGTH = 35;
const ENCODED_LENGTH = 56;

/** DER SPKI prefix identifying a raw ed25519 public key. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function base32Decode(input: string): Buffer | null {
  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (const char of input) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) return null;

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bits -= 8;
      output.push((value >> bits) & 0xff);
    }
  }

  return Buffer.from(output);
}

/** CRC16-XModem, the checksum StrKey appends little-endian. */
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

/**
 * Decodes a `G...` address to its raw 32-byte ed25519 public key, or null when
 * the address is not a well-formed Stellar public key. The checksum is verified,
 * so a typo'd or truncated address is rejected here rather than producing a
 * signature check against a key that was never real.
 */
export function decodeEd25519PublicKey(address: string): Buffer | null {
  if (typeof address !== "string" || address.length !== ENCODED_LENGTH) return null;

  const decoded = base32Decode(address);
  if (decoded === null || decoded.length !== DECODED_LENGTH) return null;

  if (decoded[0] !== VERSION_BYTE_ED25519_PUBLIC_KEY) return null;

  const payload = decoded.subarray(0, DECODED_LENGTH - 2);
  const expected = decoded.readUInt16LE(DECODED_LENGTH - 2);
  if (crc16(payload) !== expected) return null;

  return payload.subarray(1);
}

export function isValidStellarAddress(address: string): boolean {
  return decodeEd25519PublicKey(address) !== null;
}

/**
 * Verifies `signature` over `message` against the ed25519 key inside `address`.
 * Returns false rather than throwing for any malformed input, so a caller can
 * treat "bad signature" and "bad key" identically.
 */
export function verifySignature(address: string, message: string, signatureBase64: string): boolean {
  const rawKey = decodeEd25519PublicKey(address);
  if (rawKey === null) return false;

  let signature: Buffer;
  try {
    signature = Buffer.from(signatureBase64, "base64");
  } catch {
    return false;
  }
  // An ed25519 signature is always 64 bytes; Buffer.from silently accepts
  // garbage base64, so this is what actually rejects it.
  if (signature.length !== 64) return false;

  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]),
      format: "der",
      type: "spki"
    });
    return cryptoVerify(null, Buffer.from(message, "utf8"), publicKey, signature);
  } catch {
    return false;
  }
}
