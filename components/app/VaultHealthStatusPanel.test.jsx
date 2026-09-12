import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import VaultHealthStatusPanel from "./VaultHealthStatusPanel";
import { getStatusBadgeStyles } from "@/lib/status-badge-styles";

// The panel used to derive every service state from Math.random() and these
// tests had to spy on it. It now reads /api/health/vault (#115), so the cases
// below stub fetch instead and assert the four rendered severities, including
// the request-failure case that must render Unknown rather than green.

function freshRow(id, status, extra = {}) {
  return {
    id,
    name: id,
    status,
    latency_ms: 42,
    checked_at: new Date().toISOString(),
    age_ms: 0,
    stale: false,
    source: "probe",
    ...extra,
  };
}

function payload(services) {
  return {
    success: true,
    data: {
      status: "operational",
      checked_at: new Date().toISOString(),
      services,
    },
  };
}

let fetchSpy;

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
});

function mockFetch(body, init = {}) {
  fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  });
}

function iconAvatar(container) {
  return container.querySelector('span[class*="ring-2"]');
}

describe("VaultHealthStatusPanel severity styling", () => {
  it("applies the static operational classes when every service is healthy", async () => {
    mockFetch(payload([freshRow("vault-contracts", "operational"), freshRow("data-indexer", "operational")]));
    const { container } = render(<VaultHealthStatusPanel />);

    await waitFor(() =>
      expect(screen.getByText("All vault services operational")).toBeInTheDocument()
    );

    const expected = getStatusBadgeStyles("operational").iconAvatar;
    for (const token of expected.split(" ")) {
      expect(iconAvatar(container).className).toContain(token);
    }
  });

  it("applies the static degraded classes to the overall status on a partial outage", async () => {
    mockFetch(
      payload([
        freshRow("vault-contracts", "operational"),
        freshRow("data-indexer", "degraded", { message: "Indexer 3 blocks behind" }),
      ])
    );
    const { container } = render(<VaultHealthStatusPanel />);

    await waitFor(() =>
      expect(screen.getByText("Some services are experiencing issues")).toBeInTheDocument()
    );

    const expected = getStatusBadgeStyles("degraded").iconAvatar;
    for (const token of expected.split(" ")) {
      expect(iconAvatar(container).className).toContain(token);
    }
  });

  it("applies the static outage classes when every probed service is down", async () => {
    mockFetch(payload([freshRow("vault-contracts", "outage"), freshRow("data-indexer", "outage")]));
    const { container } = render(<VaultHealthStatusPanel />);

    await waitFor(() => expect(screen.getByText("Service outage detected")).toBeInTheDocument());

    const expected = getStatusBadgeStyles("outage").iconAvatar;
    for (const token of expected.split(" ")) {
      expect(iconAvatar(container).className).toContain(token);
    }
  });

  it("renders unknown, not green, when the health request fails", async () => {
    fetchSpy = vi.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));
    const { container } = render(<VaultHealthStatusPanel />);

    await waitFor(() => expect(screen.getByText("Service status unknown")).toBeInTheDocument());

    const expected = getStatusBadgeStyles("unknown").iconAvatar;
    for (const token of expected.split(" ")) {
      expect(iconAvatar(container).className).toContain(token);
    }
    // The regression this guards: an unreachable endpoint must never render as
    // "All vault services operational".
    expect(screen.queryByText("All vault services operational")).not.toBeInTheDocument();
  });

  it("shows the failure reason to the user", async () => {
    mockFetch({}, { ok: false, status: 503 });
    render(<VaultHealthStatusPanel />);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/503/)
    );
  });
});
