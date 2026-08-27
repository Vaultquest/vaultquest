import { describe, it, expect } from "vitest";
import {
  REDACTED,
  hashIdentifier,
  normalizeUnmatchedPath,
  redactWallet,
  requestLogContext,
  routeTemplate,
  sanitizeIssues,
  sanitizeQuery
} from "../src/utils/logRedaction.js";

const WALLET = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV";
const STELLAR_WALLET = "GA" + "B".repeat(54);
const CURSOR = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

describe("hashIdentifier", () => {
  it("is stable for the same value and different across values", () => {
    expect(hashIdentifier(WALLET)).toBe(hashIdentifier(WALLET));
    expect(hashIdentifier(WALLET)).not.toBe(hashIdentifier(`${WALLET}X`));
  });

  it("never contains the original value and stays short", () => {
    const hash = hashIdentifier(WALLET);
    expect(hash).not.toContain(WALLET);
    expect(hash).toMatch(/^sha256:[0-9a-f]{12}$/);
  });

  it("hashes non-string values such as repeated query parameters", () => {
    const hash = hashIdentifier([WALLET, "GOTHER"]);
    expect(hash).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(hash).not.toContain(WALLET);
  });
});

describe("redactWallet", () => {
  it("hashes a wallet without leaking any prefix of it", () => {
    const redacted = redactWallet(WALLET);
    expect(redacted).not.toContain(WALLET.slice(0, 8));
    expect(redacted).toBe(hashIdentifier(WALLET));
  });

  it("returns a marker for empty input", () => {
    expect(redactWallet(undefined)).toBe(REDACTED);
    expect(redactWallet("")).toBe(REDACTED);
  });
});

describe("sanitizeQuery", () => {
  it("hashes identifier keys", () => {
    const out = sanitizeQuery({ wallet: WALLET, cursor: CURSOR });
    expect(out.wallet).toBe(hashIdentifier(WALLET));
    expect(out.cursor).toBe(hashIdentifier(CURSOR));
    expect(JSON.stringify(out)).not.toContain(WALLET);
    expect(JSON.stringify(out)).not.toContain(CURSOR);
  });

  it("keeps allowlisted low-cardinality values for debugging", () => {
    expect(sanitizeQuery({ format: "csv", limit: "100", status: "confirmed" })).toEqual({
      format: "csv",
      limit: "100",
      status: "confirmed"
    });
  });

  it("drops secret-like keys entirely rather than hashing them", () => {
    const out = sanitizeQuery({
      api_key: "super-secret",
      signature: "c2ln",
      session_token: "abc",
      nonce: "123"
    });
    expect(out).toEqual({
      api_key: REDACTED,
      signature: REDACTED,
      session_token: REDACTED,
      nonce: REDACTED
    });
  });

  it("fails closed on unknown keys", () => {
    expect(sanitizeQuery({ somethingNew: "sensitive-value" })).toEqual({
      somethingNew: REDACTED
    });
  });

  it("is case-insensitive about key names", () => {
    const out = sanitizeQuery({ walletAddress: WALLET, Cursor: CURSOR });
    expect(out.walletAddress).toBe(hashIdentifier(WALLET));
    expect(out.Cursor).toBe(hashIdentifier(CURSOR));
  });

  it("strips control characters and bounds length in keys and values", () => {
    const out = sanitizeQuery({ ["sta\ntus"]: "conf\r\nirmed injected-line" });
    expect(Object.keys(out)).toEqual(["status"]);
    expect(out.status).toBe("confirmed injected-line");

    const long = sanitizeQuery({ limit: "9".repeat(200) });
    expect(long.limit.length).toBeLessThanOrEqual(67);
    expect(long.limit.endsWith("...")).toBe(true);
  });

  it("returns an empty object for non-object input", () => {
    expect(sanitizeQuery(undefined)).toEqual({});
    expect(sanitizeQuery("wallet=GABC")).toEqual({});
  });
});

describe("normalizeUnmatchedPath", () => {
  it("drops the query string and fragment", () => {
    expect(normalizeUnmatchedPath(`/nope?wallet=${WALLET}#frag`)).toBe("/nope");
  });

  it("decodes percent-encoded paths before normalizing", () => {
    // "%47" is an encoded "G": the address is recognized only after decoding.
    expect(normalizeUnmatchedPath(`/x/%47${"B".repeat(55)}`)).toBe("/x/:wallet");
    expect(normalizeUnmatchedPath(`/x/${STELLAR_WALLET}`)).toBe("/x/:wallet");
  });

  it("replaces identifier-shaped segments", () => {
    expect(normalizeUnmatchedPath(`/manifest/${CURSOR}`)).toBe("/manifest/:id");
  });

  it("neutralizes caller-controlled text in the path", () => {
    const normalized = normalizeUnmatchedPath("/%22injected%20log%20line%22");
    expect(normalized).toBe("/:segment");
  });

  it("bounds the overall length", () => {
    const normalized = normalizeUnmatchedPath(`/${"a/".repeat(200)}`);
    expect(normalized.length).toBeLessThanOrEqual(123);
  });
});

describe("routeTemplate", () => {
  it("prefers the registered route template", () => {
    expect(
      routeTemplate({
        url: `/actions/export?wallet=${WALLET}`,
        routeOptions: { url: "/actions/export" }
      })
    ).toBe("/actions/export");
  });

  it("falls back to the deprecated routerPath accessor", () => {
    expect(routeTemplate({ url: "/actions?wallet=x", routerPath: "/actions" })).toBe("/actions");
  });

  it("falls back to a normalized path when no route matched", () => {
    expect(routeTemplate({ url: `/unknown?wallet=${WALLET}` })).toBe("/unknown");
  });
});

describe("requestLogContext", () => {
  it("emits route, method, and redacted query metadata only", () => {
    const context = requestLogContext({
      method: "GET",
      url: `/actions?wallet=${WALLET}&cursor=${CURSOR}&limit=25`,
      routeOptions: { url: "/actions" },
      query: { wallet: WALLET, cursor: CURSOR, limit: "25" }
    });

    expect(context).toEqual({
      route: "/actions",
      method: "GET",
      query: {
        wallet: hashIdentifier(WALLET),
        cursor: hashIdentifier(CURSOR),
        limit: "25"
      }
    });
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain(WALLET);
    expect(serialized).not.toContain(CURSOR);
    expect(serialized).not.toContain("?");
  });

  it("redacts path parameters too", () => {
    const context = requestLogContext({
      method: "GET",
      url: `/api/privacy/deletion-manifest/${CURSOR}`,
      routeOptions: { url: "/api/privacy/deletion-manifest/:id" },
      params: { id: CURSOR }
    });
    expect(context.route).toBe("/api/privacy/deletion-manifest/:id");
    expect(context.params).toEqual({ id: hashIdentifier(CURSOR) });
  });

  it("omits empty query and params objects", () => {
    expect(requestLogContext({ method: "GET", url: "/health", routeOptions: { url: "/health" } })).toEqual({
      route: "/health",
      method: "GET"
    });
  });
});

describe("sanitizeIssues", () => {
  it("keeps codes and paths but drops rejected values and messages", () => {
    const issues = [
      {
        code: "invalid_string",
        path: ["wallet"],
        message: `Invalid wallet ${WALLET}`,
        received: WALLET
      }
    ];
    const sanitized = sanitizeIssues(issues as never);
    expect(sanitized).toEqual([{ code: "invalid_string", path: "wallet" }]);
    expect(JSON.stringify(sanitized)).not.toContain(WALLET);
  });

  it("caps the number of issues and tolerates missing input", () => {
    const many = Array.from({ length: 50 }, () => ({ code: "custom", path: ["a"] }));
    expect(sanitizeIssues(many as never)).toHaveLength(20);
    expect(sanitizeIssues(undefined)).toEqual([]);
  });
});
