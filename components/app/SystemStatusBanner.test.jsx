import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import SystemStatusBanner from "./SystemStatusBanner";
import { getStatusBadgeStyles } from "@/lib/status-badge-styles";

// SystemStatusBanner now fetches a single same-origin `/api/health` probe
// (#116) rather than `mode: "no-cors"` HEAD requests whose opaque responses
// always resolved "operational". The cases below mirror the issue's required
// scenarios: opaque response, HTTP error, timeout, slow-success degraded,
// and backend aggregation/invalid-payload failure.

const OPERATIONAL_CHECKS = [
  {
    id: "stellar-horizon",
    name: "Stellar Horizon API",
    url: "https://horizon.stellar.org",
    status: "operational",
    latency_ms: 120,
    error: undefined,
  },
  {
    id: "stellar-rpc",
    name: "Stellar RPC",
    url: "https://soroban-testnet.stellar.org",
    status: "operational",
    latency_ms: 210,
    error: undefined,
  },
  {
    id: "avalanche-rpc",
    name: "Avalanche RPC",
    url: "https://api.avax.network/ext/bc/C/rpc",
    status: "operational",
    latency_ms: 340,
    error: undefined,
  },
  {
    id: "backend",
    name: "VaultQuest Backend",
    url: "/health/probe",
    status: "operational",
    latency_ms: 18,
    error: undefined,
  },
];

/** Server-side "slow success": one 2xx check slower than the threshold. */
const DEGRADED_CHECKS = OPERATIONAL_CHECKS.map((check) =>
  check.id === "stellar-rpc"
    ? { ...check, status: "degraded", latency_ms: 9200, error: "Slow response (9200ms)" }
    : check,
);

const operationalProbe = {
  status: "operational",
  checked_at: "2026-08-30T12:00:00.000Z",
  checks: OPERATIONAL_CHECKS,
};

const degradedProbe = {
  status: "degraded",
  checked_at: "2026-08-30T12:00:00.000Z",
  checks: DEGRADED_CHECKS,
};

const outageProbe = {
  status: "outage",
  checked_at: "2026-08-30T12:00:00.000Z",
  checks: [
    { ...OPERATIONAL_CHECKS[0] },
    {
      id: "avalanche-rpc",
      name: "Avalanche RPC",
      url: "https://api.avax.network/ext/bc/C/rpc",
      status: "outage",
      latency_ms: 480,
      error: "HTTP 503",
    },
    { ...OPERATIONAL_CHECKS[3] },
  ],
};

function jsonResponse({ ok = true, status = 200, type = "basic", body }) {
  return Promise.resolve({
    ok,
    status,
    type,
    json: () => Promise.resolve(body),
  });
}

function mockFetchWith(responder) {
  const mock = vi.fn(responder);
  vi.stubGlobal("fetch", mock);
  return mock;
}

function abortError() {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SystemStatusBanner probe classification", () => {
  it("never treats an opaque response as healthy — renders outage", async () => {
    mockFetchWith(() => jsonResponse({ ok: true, status: 0, type: "opaque", body: null }));

    const { container } = render(<SystemStatusBanner />);

    await waitFor(() => expect(screen.getByText(/Service Down/)).toBeInTheDocument());
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await userEvent.click(screen.getByLabelText("Expand details"));
    expect(screen.getByText(/opaque response/i)).toBeInTheDocument();
  });

  it("reports outage when the same-origin probe returns an HTTP error", async () => {
    mockFetchWith(() =>
      jsonResponse({
        ok: false,
        status: 503,
        body: { status: "outage", checks: [] },
      }),
    );

    render(<SystemStatusBanner />);

    await waitFor(() => expect(screen.getByText(/Service Down/)).toBeInTheDocument());
    await userEvent.click(screen.getByLabelText("Expand details"));
    expect(screen.getByText(/HTTP 503/i)).toBeInTheDocument();
  });

  it("reports degraded when the probe request times out", async () => {
    mockFetchWith(() => Promise.reject(abortError()));

    render(<SystemStatusBanner />);

    await waitFor(() => expect(screen.getByText(/Service Degraded/)).toBeInTheDocument());
    await userEvent.click(screen.getByLabelText("Expand details"));
    expect(screen.getByText(/timed out/i)).toBeInTheDocument();
  });

  it("reports degraded for a slow-success probe flagged by the server", async () => {
    mockFetchWith(() => jsonResponse({ body: degradedProbe }));

    render(<SystemStatusBanner />);

    await waitFor(() => expect(screen.getByText(/Service Degraded/)).toBeInTheDocument());
    await userEvent.click(screen.getByLabelText("Expand details"));
    expect(screen.getByText(/Slow response \(9200ms\)/i)).toBeInTheDocument();
  });

  it("reports outage when the backend probe payload is malformed (aggregation failure)", async () => {
    mockFetchWith(() =>
      jsonResponse({ body: { status: "operational" } }), // missing `checks`
    );

    render(<SystemStatusBanner />);

    await waitFor(() => expect(screen.getByText(/Service Down/)).toBeInTheDocument());
    await userEvent.click(screen.getByLabelText("Expand details"));
    expect(screen.getByText(/invalid payload/i)).toBeInTheDocument();
  });

  it("hides the banner when every service is operational", async () => {
    const fetchMock = mockFetchWith(() => jsonResponse({ body: operationalProbe }));

    const { container } = render(<SystemStatusBanner />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("SystemStatusBanner severity styling", () => {
  it("applies the static outage banner/badge classes for the worst severity present, across every status row", async () => {
    mockFetchWith(() => jsonResponse({ body: outageProbe }));

    const { container } = render(<SystemStatusBanner />);

    await waitFor(() => expect(screen.getByText(/Service Down/)).toBeInTheDocument());

    const banner = container.querySelector('[role="alert"]');
    for (const token of getStatusBadgeStyles("outage").banner.split(" ")) {
      expect(banner.className).toContain(token);
    }

    await userEvent.click(screen.getByLabelText("Expand details"));

    const operationalBadges = screen.getAllByText("Operational").map((el) => el.closest("span"));
    const outageBadge = screen.getByText("Outage").closest("span");

    for (const [status, badges] of [
      ["operational", operationalBadges],
      ["outage", [outageBadge]],
    ]) {
      for (const badge of badges) {
        for (const token of getStatusBadgeStyles(status).badge.split(" ")) {
          expect(badge.className).toContain(token);
        }
      }
    }

    // Both themes ship together: light-mode text class and its `dark:`
    // variant must both be present, not swapped in at runtime via JS.
    expect(outageBadge.className).toContain("text-red-600");
    expect(outageBadge.className).toContain("dark:text-red-400");
  });

  it("applies the static degraded banner/badge classes when only slow results exist", async () => {
    mockFetchWith(() => jsonResponse({ body: degradedProbe }));

    const { container } = render(<SystemStatusBanner />);

    await waitFor(() => expect(screen.getByText(/Service Degraded/)).toBeInTheDocument());

    const banner = container.querySelector('[role="alert"]');
    for (const token of getStatusBadgeStyles("degraded").banner.split(" ")) {
      expect(banner.className).toContain(token);
    }

    await userEvent.click(screen.getByLabelText("Expand details"));
    const degradedBadge = screen.getByText("Degraded").closest("span");
    for (const token of getStatusBadgeStyles("degraded").badge.split(" ")) {
      expect(degradedBadge.className).toContain(token);
    }
  });
});