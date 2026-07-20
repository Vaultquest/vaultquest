import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import VaultDataRefresh from "./VaultDataRefresh";

describe("VaultDataRefresh", () => {
  it("distinguishes loading, stale, degraded, and unavailable states", () => {
    const { rerender } = render(
      <VaultDataRefresh status="loading" isRefreshing onRefresh={vi.fn()} />,
    );
    expect(screen.getByText("Loading latest data")).toBeInTheDocument();

    rerender(<VaultDataRefresh status="stale" isRefreshing={false} onRefresh={vi.fn()} />);
    expect(screen.getByText("Data is stale")).toBeInTheDocument();

    rerender(<VaultDataRefresh status="degraded" isRefreshing={false} onRefresh={vi.fn()} />);
    expect(screen.getByText("Partially degraded")).toBeInTheDocument();

    rerender(<VaultDataRefresh status="unavailable" isRefreshing={false} onRefresh={vi.fn()} />);
    expect(screen.getByText("Data unavailable")).toBeInTheDocument();
  });

  it("runs a real refresh callback and renders the successful fresh state", () => {
    const onRefresh = vi.fn().mockResolvedValue({ data: { vaults: [] } });
    const { rerender } = render(
      <VaultDataRefresh status="stale" isRefreshing={false} onRefresh={onRefresh} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh data" }));
    expect(onRefresh).toHaveBeenCalledOnce();

    rerender(
      <VaultDataRefresh
        status="fresh"
        updatedAt={new Date()}
        isRefreshing={false}
        onRefresh={onRefresh}
      />,
    );
    expect(screen.getByText("Live data")).toBeInTheDocument();
  });
});
