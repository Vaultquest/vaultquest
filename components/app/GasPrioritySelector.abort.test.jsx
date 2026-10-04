import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import GasPrioritySelector from "./GasPrioritySelector";

const originalFetch = global.fetch;
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function pendingFetch(requests) {
  return vi.fn((url, options = {}) => new Promise((resolve, reject) => {
    requests.push({ url: String(url), signal: options.signal, resolve });
    options.signal?.addEventListener("abort", () => {
      reject(new DOMException("Obsolete fee request", "AbortError"));
    }, { once: true });
  }));
}

it("aborts the obsolete Horizon request and gives its replacement a live signal", async () => {
  const requests = [];
  global.fetch = pendingFetch(requests);
  const { rerender } = render(
    <GasPrioritySelector customHorizonUrl="https://first.example" nativeBalance={1} />,
  );
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0].signal?.aborted).toBe(false);

  rerender(<GasPrioritySelector customHorizonUrl="https://second.example" nativeBalance={1} />);
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[0].signal.aborted).toBe(true);
  expect(requests[1].signal.aborted).toBe(false);
  expect(requests[1].signal).not.toBe(requests[0].signal);
  expect(requests[1].url).toBe("https://second.example/fee_stats");
  await act(async () => {
    requests[1].resolve(new Response(JSON.stringify({ last_ledger: 12345, last_ledger_base_fee: 120 }), { status: 200 }));
  });
  await waitFor(() => expect(screen.getByTestId("metric-ledger")).toHaveTextContent("#12345"));
  expect(screen.getByTestId("metric-freshness")).toHaveTextContent("Live rate");
  expect(screen.queryByTestId("fee-warning-alert")).toBeNull();
});

it("aborts an in-flight Stellar request on unmount without a late callback", async () => {
  const requests = [];
  global.fetch = pendingFetch(requests);
  const onChange = vi.fn();
  const { unmount } = render(
    <GasPrioritySelector customHorizonUrl="https://pending.example" onChange={onChange} />,
  );
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0].signal?.aborted).toBe(false);
  const callsBeforeUnmount = onChange.mock.calls.length;
  await act(async () => { unmount(); });
  expect(requests[0].signal.aborted).toBe(true);
  expect(onChange).toHaveBeenCalledTimes(callsBeforeUnmount);
});
