import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_AGE_MS,
  fetchVaultHealth,
  normalizeVaultHealth,
  VAULT_HEALTH_URL,
} from "./vault-health";

// Fixed clock: freshness decisions must not depend on machine speed.
const NOW = Date.parse("2026-09-13T12:00:00.000Z");
const iso = (msAgo = 0) => new Date(NOW - msAgo).toISOString();

function row(id, status, overrides = {}) {
  return {
    id,
    name: id,
    status,
    latency_ms: 42,
    checked_at: iso(0),
    age_ms: 0,
    stale: false,
    source: "probe",
    ...overrides,
  };
}

function payload(services, checkedAt = iso(0)) {
  return { status: "operational", checked_at: checkedAt, services };
}

const HEALTHY = payload([
  row("data-indexer", "operational"),
  row("vault-contracts", "operational"),
  row("prize-oracle", "unknown", { latency_ms: null, checked_at: null, source: "none" }),
]);

describe("normalizeVaultHealth", () => {
  it("reports operational when the probed services are healthy", () => {
    const result = normalizeVaultHealth(HEALTHY, { now: NOW });
    expect(result.overall).toBe("operational");
    expect(result.reason).toBeNull();
    expect(result.services.map((s) => s.status)).toEqual([
      "operational",
      "unknown",
      "operational",
    ]);
  });

  it("renders a stale reading as unknown instead of healthy", () => {
    const stale = payload(
      [
        row("data-indexer", "operational", {
          checked_at: iso(DEFAULT_MAX_AGE_MS + 60000),
          age_ms: DEFAULT_MAX_AGE_MS + 60000,
          stale: true,
        }),
        row("vault-contracts", "operational"),
      ],
      iso(0)
    );
    const result = normalizeVaultHealth(stale, { now: NOW });
    const indexer = result.services.find((s) => s.id === "data-indexer");
    expect(indexer.status).toBe("unknown");
    expect(indexer.stale).toBe(true);
    expect(indexer.message).toMatch(/freshness|stale/i);
  });

  it("treats a whole stale payload as unknown", () => {
    const result = normalizeVaultHealth(
      payload([row("data-indexer", "operational")], iso(DEFAULT_MAX_AGE_MS + 1)),
      { now: NOW }
    );
    expect(result.overall).toBe("unknown");
    expect(result.reason).toMatch(/freshness/i);
  });

  it("reports degraded on a partial outage", () => {
    const result = normalizeVaultHealth(
      payload([
        row("data-indexer", "degraded", { message: "Indexer 3 blocks behind" }),
        row("vault-contracts", "operational"),
      ]),
      { now: NOW }
    );
    expect(result.overall).toBe("degraded");
    expect(result.services.find((s) => s.id === "data-indexer").message).toBe(
      "Indexer 3 blocks behind"
    );
  });

  it("reports outage when every probed service is down", () => {
    const result = normalizeVaultHealth(
      payload([row("data-indexer", "outage"), row("vault-contracts", "outage")]),
      { now: NOW }
    );
    expect(result.overall).toBe("outage");
  });

  it("adds an unknown row for a service the backend did not report", () => {
    const result = normalizeVaultHealth(
      payload([row("vault-contracts", "operational")]),
      { now: NOW }
    );
    const missing = result.services.find((s) => s.id === "data-indexer");
    expect(missing.status).toBe("unknown");
    expect(missing.message).toMatch(/not reported/i);
  });

  it("rejects an unrecognised status rather than trusting it", () => {
    const result = normalizeVaultHealth(
      payload([row("vault-contracts", "probably-fine")]),
      { now: NOW }
    );
    expect(result.services.find((s) => s.id === "vault-contracts").status).toBe("unknown");
  });

  it("returns all unknown for a malformed payload", () => {
    for (const bad of [null, undefined, "nope", 42, {}, { services: "not-an-array" }]) {
      const result = normalizeVaultHealth(bad, { now: NOW });
      expect(result.overall).toBe("unknown");
      expect(result.services.every((s) => s.status === "unknown")).toBe(true);
    }
  });
});

function jsonResponse(body, init = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  };
}

describe("fetchVaultHealth", () => {
  it("unwraps the endpoint envelope and normalises it", async () => {
    const seen = [];
    const fetcher = async (url) => {
      seen.push(url);
      return jsonResponse({ success: true, data: HEALTHY });
    };
    const result = await fetchVaultHealth({ fetcher, now: NOW });
    expect(seen[0]).toBe(VAULT_HEALTH_URL);
    expect(result.overall).toBe("operational");
  });

  it("reports unknown, with a reason, when the request times out", async () => {
    const fetcher = async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    };
    const result = await fetchVaultHealth({ fetcher, timeoutMs: 1234, now: NOW });
    expect(result.overall).toBe("unknown");
    expect(result.reason).toMatch(/timed out/i);
    expect(result.reason).toContain("1234");
  });

  it("reports unknown for an HTTP error", async () => {
    const fetcher = async () =>
      jsonResponse({}, { ok: false, status: 503 });
    const result = await fetchVaultHealth({ fetcher, now: NOW });
    expect(result.overall).toBe("unknown");
    expect(result.reason).toContain("503");
  });

  it("reports unknown when the body is not JSON", async () => {
    const fetcher = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("Unexpected token <");
      },
    });
    const result = await fetchVaultHealth({ fetcher, now: NOW });
    expect(result.overall).toBe("unknown");
    expect(result.reason).toMatch(/JSON/i);
  });

  it("reports unknown when no fetch implementation exists", async () => {
    const original = global.fetch;
    delete global.fetch;
    try {
      const result = await fetchVaultHealth({ now: NOW });
      expect(result.overall).toBe("unknown");
    } finally {
      global.fetch = original;
    }
  });
});
