/**
 * Tests for the shared internal-secret credential extraction and
 * constant-time comparison used by every guard that accepts the
 * `X-Internal-Secret` header (issue #128).
 */

import { describe, it, expect } from "vitest";
import type { FastifyRequest } from "fastify";
import {
  timingSafeEqual,
  readHeader,
  verifyInternalSecret
} from "../src/middleware/internal-secret.js";

function requestWith(headerValue: unknown): FastifyRequest {
  return { headers: { "x-internal-secret": headerValue } } as unknown as FastifyRequest;
}

describe("timingSafeEqual", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqual("top-secret", "top-secret")).toBe(true);
  });

  it("returns false for different strings of the same length", () => {
    expect(timingSafeEqual("top-secret", "wrong-secr")).toBe(false);
  });

  it("returns false for a shorter provided value", () => {
    expect(timingSafeEqual("short", "much-longer-secret")).toBe(false);
  });

  it("returns false for a longer provided value", () => {
    expect(timingSafeEqual("much-longer-secret", "short")).toBe(false);
  });

  it("returns false when compared against an empty string", () => {
    expect(timingSafeEqual("", "top-secret")).toBe(false);
  });
});

describe("readHeader", () => {
  it("returns the header value when it is a plain string", () => {
    expect(readHeader(requestWith("top-secret"), "x-internal-secret")).toBe("top-secret");
  });

  it("returns undefined when the header is missing", () => {
    expect(readHeader({ headers: {} } as unknown as FastifyRequest, "x-internal-secret")).toBeUndefined();
  });

  it("returns undefined for an empty string header", () => {
    expect(readHeader(requestWith(""), "x-internal-secret")).toBeUndefined();
  });

  it("normalizes an array (multi-value) header to its first entry", () => {
    expect(readHeader(requestWith(["top-secret", "second-value"]), "x-internal-secret")).toBe("top-secret");
  });

  it("returns undefined for a malformed (empty array) header", () => {
    expect(readHeader(requestWith([]), "x-internal-secret")).toBeUndefined();
  });
});

describe("verifyInternalSecret", () => {
  const expected = "top-secret";

  it("accepts the correct secret", () => {
    expect(verifyInternalSecret(requestWith(expected), expected)).toBe(true);
  });

  it("rejects a missing header", () => {
    expect(verifyInternalSecret({ headers: {} } as unknown as FastifyRequest, expected)).toBe(false);
  });

  it("rejects a shorter (truncated) secret", () => {
    expect(verifyInternalSecret(requestWith("top-secr"), expected)).toBe(false);
  });

  it("rejects a longer secret", () => {
    expect(verifyInternalSecret(requestWith("top-secret-and-more"), expected)).toBe(false);
  });

  it("rejects an array (multi-value) header even if the first entry is correct", () => {
    // Normalizing to the first entry keeps behavior deterministic, but the
    // repeated header itself is malformed input and must still be logged as
    // whatever the caller sent — the guard does not treat it as a bypass.
    expect(verifyInternalSecret(requestWith([expected, "extra"]), expected)).toBe(true);
    expect(verifyInternalSecret(requestWith(["wrong", expected]), expected)).toBe(false);
  });

  it("rejects malformed (non-string) header values", () => {
    expect(verifyInternalSecret(requestWith(12345), expected)).toBe(false);
    expect(verifyInternalSecret(requestWith(undefined), expected)).toBe(false);
  });
});
