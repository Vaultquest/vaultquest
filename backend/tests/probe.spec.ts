import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import {
  probeDependencies,
  aggregateProbeStatus,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_SLOW_THRESHOLD_MS,
} from "../src/services/probeService.js";
import type {
  ProbeFetcher,
  ProbeCheck,
  ProbeTarget,
} from "../src/services/probeService.js";
import { healthRoutes } from "../src/routes/health.js";
import type { LedgerService } from "../src/services/ledger.js";
import type { PrismaClient } from "@prisma/client";

// ---------------------------------------------------------------------------
// Helpers — a stub fetch that never touches the network. Matching fetch's
// shape (ok + status) keeps the service contract honest without pulling in a
// full Response polyfill the Node test env does not have.
// ---------------------------------------------------------------------------

function okResponse(): { ok: boolean; status: number } {
  return { ok: true, status: 200 };
}

function errorResponse(status: number): { ok: boolean; status: number } {
  return { ok: false, status };
}

/**
 * fetchFn that resolves after `delayMs`, optionally honoring the abort
 * signal so a real timeout path can be exercised deterministically.
 */
function delayedFetcher(delayMs: number, response: { ok: boolean; status: number }): ProbeFetcher {
  return (_url, init) =>
    new Promise((resolve, reject) => {
      const signal = init?.signal;
      const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
      if (signal) {
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
      }
      setTimeout(() => {
        if (signal) signal.removeEventListener("abort", abort);
        resolve(response);
      }, delayMs);
    });
}

function rejectingFetcher(err: Error): ProbeFetcher {
  return () => Promise.reject(err);
}

function neverFetcher(): ProbeFetcher {
  return () => new Promise(() => {});
}

const fixedNow = () => new Date("2026-08-30T12:00:00.000Z");

// ---------------------------------------------------------------------------
// probeDependencies                      (service-level layout for testing)
// ---------------------------------------------------------------------------

describe("probeDependencies", () => {
  it("reports operational with elapsed latency when every target answers 2xx quickly", async () => {
    const fetchFn = vi.fn(delayedFetcher(5, okResponse()));
    const result = await probeDependencies({
      targets: [
        { id: "a", name: "A", url: "https://a.invalid" },
        { id: "b", name: "B", url: "https://b.invalid" },
      ],
      fetchFn,
      now: fixedNow,
    });

    expect(result.status).toBe("operational");
    expect(result.checked_at).toBe("2026-08-30T12:00:00.000Z");
    expect(result.checks).toHaveLength(3); // two remotes + synthetic backend
    for (const check of result.checks) {
      expect(check.status).toBe("operational");
      // latency is elapsed time, never a wall-clock stamp — it must be in a
      // plausible ms range around the ~5ms stub delay, and always >= 0.
      expect(check.latency_ms).toBeGreaterThanOrEqual(0);
      expect(check.latency_ms).toBeLessThan(1000);
    }
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("classifies a non-2xx HTTP response as outage with the status in the error", async () => {
    const result = await probeDependencies({
      targets: [{ id: "horizon", name: "Horizon", url: "https://horizon.stellar.org" }],
      fetchFn: delayedFetcher(0, errorResponse(503)),
      now: fixedNow,
    });

    const horizon = result.checks.find((c) => c.id === "horizon");
    expect(horizon?.status).toBe("outage");
    expect(horizon?.error).toBe("HTTP 503");
    expect(result.status).toBe("outage");
  });

  it("classifies a network rejection as outage", async () => {
    const result = await probeDependencies({
      targets: [{ id: "rpc", name: "RPC", url: "https://rpc.invalid" }],
      fetchFn: rejectingFetcher(new Error("fetch failed: getaddrinfo ENOTFOUND")),
      now: fixedNow,
    });

    const rpc = result.checks.find((c) => c.id === "rpc");
    expect(rpc?.status).toBe("outage");
    expect(rpc?.error).toContain("getaddrinfo ENOTFOUND");
  });

  it("classifies a timeout as degraded and clamps latency to the timeout bound", async () => {
    const result = await probeDependencies({
      targets: [{ id: "rpc", name: "RPC", url: "https://rpc.invalid" }],
      fetchFn: neverFetcher(),
      timeoutMs: 50,
      now: fixedNow,
    });

    const rpc = result.checks.find((c) => c.id === "rpc");
    expect(rpc?.status).toBe("degraded");
    expect(rpc?.error).toContain("timed out after 50ms");
    // A hung upstream must never report a latency larger than the wait.
    expect(rpc?.latency_ms).toBeLessThanOrEqual(50);
  });

  it("classifies a slow 2xx response as degraded", async () => {
    const result = await probeDependencies({
      targets: [{ id: "horizon", name: "Horizon", url: "https://horizon.stellar.org" }],
      fetchFn: delayedFetcher(40, okResponse()),
      slowThresholdMs: 10,
      timeoutMs: 2000,
      now: fixedNow,
    });

    const horizon = result.checks.find((c) => c.id === "horizon");
    expect(horizon?.status).toBe("degraded");
    expect(horizon?.error).toContain("Slow response");
    expect(result.status).toBe("degraded");
  });

  it("issues POST with a JSON body for JSON-RPC targets and passes an abort signal", async () => {
    const fetchFn = vi.fn(delayedFetcher(0, okResponse()));
    const avalanche: ProbeTarget = {
      id: "avalanche-rpc",
      name: "Avalanche RPC",
      url: "https://api.avax.network/ext/bc/C/rpc",
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
    };

    await probeDependencies({ targets: [avalanche], fetchFn, now: fixedNow });

    const [, init] = fetchFn.mock.calls[0];
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const sentBody = JSON.parse(init?.body as string);
    expect(sentBody).toEqual({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] });
  });

  it("includes a synthetic backend check proving the probe executed", async () => {
    const result = await probeDependencies({
      targets: [{ id: "a", name: "A", url: "https://a.invalid" }],
      fetchFn: delayedFetcher(0, okResponse()),
      now: fixedNow,
    });

    const backend = result.checks.find((c) => c.id === "backend");
    expect(backend?.status).toBe("operational");
    expect(backend?.url).toBe("/health/probe");
  });
});

describe("aggregateProbeStatus", () => {
  const check = (status: ProbeCheck["status"]): ProbeCheck => ({
    id: status,
    name: status,
    url: "https://x.invalid",
    status,
    latency_ms: 1,
  });

  it("is operational only when every check is operational", () => {
    expect(aggregateProbeStatus([check("operational"), check("operational")])).toBe("operational");
  });

  it("degrades when a single slow check exists but nothing is down", () => {
    expect(
      aggregateProbeStatus([check("operational"), check("degraded")])
    ).toBe("degraded");
  });

  it("lets any outage win over degraded and operational", () => {
    expect(
      aggregateProbeStatus([check("degraded"), check("outage")])
    ).toBe("outage");
    expect(
      aggregateProbeStatus([check("operational"), check("operational"), check("outage")])
    ).toBe("outage");
  });
});

describe("default probe configuration", () => {
  it("uses a bounded default timeout and slow threshold", () => {
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBe(5000);
    expect(DEFAULT_SLOW_THRESHOLD_MS).toBe(1500);
  });
});

// ---------------------------------------------------------------------------
// GET /health/probe (route) — mounted through the same healthRoutes factory
// the app registers, with an injected stub fetch so the test never leaves the
// process.
// ---------------------------------------------------------------------------

describe("GET /health/probe (route)", () => {
  it("proxies the probe result through the { data } envelope without hitting the network", async () => {
    const app = Fastify();
    app.register(
      healthRoutes(
        {} as unknown as LedgerService,
        {} as unknown as PrismaClient,
        undefined,
        {},
        {
          targets: [{ id: "horizon", name: "Horizon", url: "https://horizon.stellar.org" }],
          fetchFn: delayedFetcher(0, okResponse()),
          now: fixedNow,
        }
      )
    );
    await app.ready();

    try {
      const res = await app.inject({ method: "GET", url: "/health/probe" });
      expect(res.statusCode).toBe(200);
      const payload = res.json();
      expect(payload.data.status).toBe("operational");
      expect(payload.data.checked_at).toBe("2026-08-30T12:00:00.000Z");
      expect(payload.data.checks.find((c: ProbeCheck) => c.id === "horizon")?.status).toBe("operational");
      expect(payload.data.checks.find((c: ProbeCheck) => c.id === "backend")?.status).toBe("operational");
    } finally {
      await app.close();
    }
  });

  it("does not alter existing /health liveness semantics", async () => {
    const app = Fastify();
    app.register(
      healthRoutes(
        {} as unknown as LedgerService,
        {} as unknown as PrismaClient,
        undefined,
        {},
        { fetchFn: okResponse }
      )
    );
    await app.ready();

    try {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.status).toBe("ok");
    } finally {
      await app.close();
    }
  });
});