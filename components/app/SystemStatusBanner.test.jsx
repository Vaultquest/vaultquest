import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import SystemStatusBanner from "./SystemStatusBanner";
import { getStatusBadgeStyles } from "@/lib/status-badge-styles";

// SystemStatusBanner derives each endpoint's status from a live `fetch`;
// mocking it forces operational/degraded/outage to appear deterministically
// in one render so the static classes for every severity can be asserted.
function mockFetchByEndpoint() {
  return vi.fn((url) => {
    if (url.includes("horizon.stellar.org") || url === "/api/health") {
      return Promise.resolve({});
    }
    if (url.includes("soroban-testnet.stellar.org")) {
      const abortError = new Error("The operation was aborted.");
      abortError.name = "AbortError";
      return Promise.reject(abortError);
    }
    // api.avax.network
    return Promise.reject(new Error("Network request failed"));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SystemStatusBanner severity styling", () => {
  it("applies the static outage banner/badge classes for the worst severity present, across every status row", async () => {
    vi.stubGlobal("fetch", mockFetchByEndpoint());

    const { container } = render(<SystemStatusBanner />);

    await waitFor(() => expect(screen.getByText(/Service Down/)).toBeInTheDocument());

    const banner = container.querySelector('[role="alert"]');
    for (const token of getStatusBadgeStyles("outage").banner.split(" ")) {
      expect(banner.className).toContain(token);
    }

    await userEvent.click(screen.getByLabelText("Expand details"));

    const operationalBadges = screen.getAllByText("Operational").map((el) => el.closest("span"));
    const degradedBadge = screen.getByText("Degraded").closest("span");
    const outageBadge = screen.getByText("Outage").closest("span");

    for (const [status, badges] of [
      ["operational", operationalBadges],
      ["degraded", [degradedBadge]],
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
});
