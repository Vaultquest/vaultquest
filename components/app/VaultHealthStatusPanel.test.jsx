import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import VaultHealthStatusPanel from "./VaultHealthStatusPanel";
import { getStatusBadgeStyles } from "@/lib/status-badge-styles";

// VAULT_SERVICES derive status from Math.random(); mocking it forces a
// deterministic outcome so each severity's static classes can be asserted
// instead of screenshotting whatever the dice roll produced. Only this spy
// is torn down (not vi.restoreAllMocks()) so the shared window.matchMedia
// mock from tests/setup.ts, which framer-motion relies on, stays intact.
let randomSpy;

afterEach(() => {
  randomSpy?.mockRestore();
});

function iconAvatar(container) {
  return container.querySelector('span[class*="ring-2"]');
}

describe("VaultHealthStatusPanel severity styling", () => {
  it("applies the static operational classes when every service is healthy", async () => {
    randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.9);
    const { container } = render(<VaultHealthStatusPanel />);

    await waitFor(() => expect(screen.getByText("All vault services operational")).toBeInTheDocument());

    const expected = getStatusBadgeStyles("operational").iconAvatar;
    for (const token of expected.split(" ")) {
      expect(iconAvatar(container).className).toContain(token);
    }
  });

  it("applies the static degraded classes to the overall status and each affected service row, pairing light/dark text variants", async () => {
    randomSpy = vi
      .spyOn(Math, "random")
      .mockReturnValueOnce(0.05) // vault-contracts -> degraded
      .mockReturnValueOnce(0.9) // prize-oracle -> operational
      .mockReturnValueOnce(0.05); // data-indexer -> degraded

    const { container } = render(<VaultHealthStatusPanel />);
    await waitFor(() =>
      expect(screen.getByText("Some services are experiencing issues")).toBeInTheDocument()
    );

    const overallExpected = getStatusBadgeStyles("degraded").iconAvatar;
    for (const token of overallExpected.split(" ")) {
      expect(iconAvatar(container).className).toContain(token);
    }

    await userEvent.click(screen.getByLabelText("Expand details"));

    const degradedBadges = screen.getAllByText("Degraded").map((el) => el.closest("span"));
    const healthyBadge = screen.getByText("Healthy").closest("span");
    for (const badge of degradedBadges) {
      for (const token of getStatusBadgeStyles("degraded").badge.split(" ")) {
        expect(badge.className).toContain(token);
      }
    }
    for (const token of getStatusBadgeStyles("operational").badge.split(" ")) {
      expect(healthyBadge.className).toContain(token);
    }

    // Both themes ship in the same render: the light-mode text class and its
    // `dark:` variant must be present together, not swapped in via JS.
    expect(degradedBadges[0].className).toContain("text-amber-600");
    expect(degradedBadges[0].className).toContain("dark:text-amber-400");
  });
});
