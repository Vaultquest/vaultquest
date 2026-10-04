import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GasPrioritySelector from "./GasPrioritySelector";

describe("GasPrioritySelector — Stellar fee isolation (#123)", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    global.fetch = originalFetch;
  });

  it("fetches fee_stats from Stellar testnet Horizon and renders stroops, source ledger, and freshness", async () => {
    global.fetch = vi.fn().mockImplementation(async (url) => {
      if (String(url).includes("fee_stats")) {
        return new Response(
          JSON.stringify({
            last_ledger: 5432100,
            last_ledger_base_fee: 120,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });

    const onChange = vi.fn();
    render(
      <GasPrioritySelector
        network="stellar"
        networkType="testnet"
        nativeBalance={25.0}
        onChange={onChange}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("metric-base-fee")).toHaveTextContent("120 stroops");
    });
    expect(screen.getByTestId("metric-ledger")).toHaveTextContent("#5432100");
    expect(screen.getByTestId("metric-freshness")).toHaveTextContent("Live rate");
    expect(screen.queryByText(/\bwei\b/i)).toBeNull();
    expect(screen.queryByText(/avalanche c-chain/i)).toBeNull();
    expect(screen.getByTestId("metric-base-fee").textContent).toMatch(/stroops/i);
    expect(screen.getByTestId("metric-base-fee").textContent).not.toMatch(/wei/i);

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall.network).toBe("Stellar");
    expect(lastCall.payload.type).toBe("stellar");
    expect(lastCall.payload.feeStroops).toBe(120);
    expect(lastCall.payload.sourceLedger).toBe("5432100");
    expect(lastCall.isStale).toBe(false);
  });

  it("targets Stellar mainnet Horizon when networkType is mainnet", async () => {
    let requestedUrl = "";
    global.fetch = vi.fn().mockImplementation(async (url) => {
      requestedUrl = String(url);
      return new Response(
        JSON.stringify({ last_ledger: 998877, last_ledger_base_fee: 100 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    render(
      <GasPrioritySelector network="stellar" networkType="mainnet" nativeBalance={50.0} />,
    );

    await waitFor(() => {
      expect(requestedUrl).toContain("https://horizon.stellar.org/fee_stats");
    });
    expect(screen.getByTestId("metric-ledger")).toHaveTextContent("#998877");
  });

  it("respects custom Horizon URL override", async () => {
    let requestedUrl = "";
    global.fetch = vi.fn().mockImplementation(async (url) => {
      requestedUrl = String(url);
      return new Response(
        JSON.stringify({ last_ledger: 112233, last_ledger_base_fee: 150 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    render(
      <GasPrioritySelector
        network="stellar"
        customHorizonUrl="https://my-custom-horizon.org"
      />,
    );

    await waitFor(() => {
      expect(requestedUrl).toBe("https://my-custom-horizon.org/fee_stats");
    });
    expect(screen.getByTestId("metric-base-fee")).toHaveTextContent("150 stroops");
    expect(screen.getByTestId("metric-ledger")).toHaveTextContent("#112233");
  });

  it("handles stale fee data when Horizon is unreachable", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Network connection dropped"));
    const onChange = vi.fn();

    render(
      <GasPrioritySelector network="stellar" nativeBalance={10.0} onChange={onChange} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("metric-freshness")).toHaveTextContent("Stale data");
    });
    expect(screen.getByTestId("metric-base-fee")).toHaveTextContent("100 stroops");
    expect(screen.getByTestId("metric-ledger")).toHaveTextContent("Fallback ledger");
    expect(screen.getByTestId("fee-warning-alert")).toHaveTextContent(/stale fee notice|network warning/i);

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall.isStale).toBe(true);
    expect(lastCall.payload.sourceLedger).toBe("fallback");
  });

  it("renders unsupported network state and disables tiers", async () => {
    render(<GasPrioritySelector network="stellar" isUnsupported />);

    expect(screen.getByTestId("unsupported-network-alert")).toHaveTextContent(
      /unsupported network/i,
    );
    expect(screen.getByTestId("tier-btn-low")).toBeDisabled();
    expect(screen.getByTestId("tier-btn-medium")).toBeDisabled();
    expect(screen.getByTestId("tier-btn-high")).toBeDisabled();
  });

  it("includes Soroban simulationResourceFee in total stroops", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ last_ledger: 654321, last_ledger_base_fee: 100 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const onChange = vi.fn();

    render(
      <GasPrioritySelector
        network="stellar"
        simulationResourceFee={4900}
        onChange={onChange}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("metric-base-fee")).toHaveTextContent("100 stroops");
    });

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall.payload.feeStroops).toBe(5000);
    expect(lastCall.payload.resourceFeeStroops).toBe(4900);
    expect(lastCall.payload.feeBid).toBe("0.0005000 XLM");
  });

  it("applies priority tier multipliers to the Stellar fee bid", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ last_ledger: 1000, last_ledger_base_fee: 200 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const onChange = vi.fn();

    render(<GasPrioritySelector network="stellar" onChange={onChange} />);

    await waitFor(() => {
      expect(screen.getByTestId("metric-base-fee")).toHaveTextContent("200 stroops");
    });

    fireEvent.click(screen.getByTestId("tier-btn-high"));

    await waitFor(() => {
      const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
      expect(lastCall.tier.key).toBe("high");
      expect(lastCall.payload.feeStroops).toBe(250);
      expect(lastCall.payload.feeBid).toBe("0.0000250 XLM");
    });
  });

  it("keeps Avalanche fee math available when network is explicitly avalanche", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: "0x5d21dba00" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const onChange = vi.fn();

    render(
      <GasPrioritySelector network="avalanche" nativeBalance={2.5} onChange={onChange} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("metric-base-fee")).toHaveTextContent(/wei/i);
    });

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall.network).toBe("Avalanche");
    expect(lastCall.payload.type).toBe("evm");
    expect(lastCall.payload.chain).toBe("Avalanche C-Chain");
  });

  describe("Stellar sample context", () => {
    function response(ledger = 111111, baseFee = 120) {
      return new Response(
        JSON.stringify({ last_ledger: ledger, last_ledger_base_fee: baseFee }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    function heldResponse() {
      let resolve;
      let reject;
      const promise = new Promise((done, fail) => {
        resolve = done;
        reject = fail;
      });
      return { promise, resolve, reject };
    }

    function latest(onChange) {
      return onChange.mock.calls[onChange.mock.calls.length - 1][0];
    }

    async function renderLoaded(props = {}) {
      const onChange = vi.fn();
      const view = render(
        <GasPrioritySelector
          nativeBalance={25}
          {...props}
          onChange={onChange}
        />,
      );
      await waitFor(() => expect(latest(onChange).sourceLedger).toBe("111111"));
      return { ...view, onChange };
    }

    function expectUnassigned(onChange, networkType = "testnet") {
      expect(onChange).toHaveBeenCalled();
      for (const [value] of onChange.mock.calls) {
        expect(value).toMatchObject({
          networkType,
          sourceLedger: "fallback",
          isStale: true,
          payload: {
            network: networkType,
            sourceLedger: "fallback",
            horizonUrl: null,
            isStale: true,
          },
        });
      }
      expect(screen.getByTestId("metric-ledger")).toHaveTextContent(
        "Fallback ledger",
      );
    }

    it.each([
      ["testnet", "mainnet"],
      ["mainnet", "testnet"],
    ])(
      "clears %s attribution during the first %s render and every pending callback",
      async (from, to) => {
        const pending = heldResponse();
        global.fetch = vi
          .fn()
          .mockResolvedValueOnce(response())
          .mockReturnValueOnce(pending.promise);
        const onChange = vi.fn();
        const layouts = [];
        function ObservedSelector({ networkType }) {
          React.useLayoutEffect(() => {
            layouts.push(screen.getByTestId("metric-ledger").textContent);
          });
          return (
            <GasPrioritySelector
              networkType={networkType}
              nativeBalance={25}
              onChange={onChange}
            />
          );
        }
        const view = render(<ObservedSelector networkType={from} />);
        await waitFor(() =>
          expect(latest(onChange).sourceLedger).toBe("111111"),
        );
        layouts.length = 0;
        onChange.mockClear();
        view.rerender(<ObservedSelector networkType={to} />);
        expect(layouts).toEqual(["Fallback ledger"]);
        expectUnassigned(onChange, to);
        await act(async () => {
          pending.resolve(response(222222, 220));
        });
        expect(latest(onChange)).toMatchObject({
          networkType: to,
          sourceLedger: "222222",
          isStale: false,
          payload: {
            horizonUrl:
              to === "mainnet"
                ? "https://horizon.stellar.org"
                : "https://horizon-testnet.stellar.org",
          },
        });
      },
    );

    it("clears a custom Horizon sample until its replacement source responds", async () => {
      const pending = heldResponse();
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(response())
        .mockReturnValueOnce(pending.promise);
      const { rerender, onChange } = await renderLoaded({
        customHorizonUrl: "https://fee-a.example",
      });
      onChange.mockClear();
      rerender(
        <GasPrioritySelector
          nativeBalance={25}
          customHorizonUrl="https://fee-b.example"
          onChange={onChange}
        />,
      );
      expectUnassigned(onChange);
      await act(async () => {
        pending.resolve(response(222222));
      });
      expect(latest(onChange)).toMatchObject({
        sourceLedger: "222222",
        isStale: false,
        payload: { horizonUrl: "https://fee-b.example", isStale: false },
      });
    });

    it("does not attribute a failed new Horizon lookup to the preceding source", async () => {
      const pending = heldResponse();
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(response())
        .mockReturnValueOnce(pending.promise);
      const { rerender, onChange } = await renderLoaded({
        customHorizonUrl: "https://fee-a.example",
      });
      rerender(
        <GasPrioritySelector
          nativeBalance={25}
          customHorizonUrl="https://fee-b.example"
          onChange={onChange}
        />,
      );
      onChange.mockClear();
      await act(async () => {
        pending.reject(new Error("New Horizon unavailable"));
      });
      expectUnassigned(onChange);
      expect(screen.getByTestId("fee-warning-alert")).toHaveTextContent(
        "New Horizon unavailable",
      );
    });

    it("retains a valid sample during a refresh of the same context", async () => {
      const pending = heldResponse();
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(response())
        .mockReturnValueOnce(pending.promise);
      const { onChange } = await renderLoaded();
      const sample = latest(onChange);
      fireEvent.click(screen.getByTestId("refresh-fees-btn"));
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(latest(onChange)).toEqual(sample);
      expect(screen.getByTestId("metric-ledger")).toHaveTextContent("#111111");
      await act(async () => {
        pending.resolve(response(222222, 220));
      });
      expect(latest(onChange)).toMatchObject({
        sourceLedger: "222222",
        isStale: false,
      });
    });

    it("requires a new matching response when returning to an earlier network context", async () => {
      const mainnet = heldResponse();
      const testnet = heldResponse();
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(response())
        .mockReturnValueOnce(mainnet.promise)
        .mockReturnValueOnce(testnet.promise);
      const { rerender, onChange } = await renderLoaded();
      rerender(
        <GasPrioritySelector
          nativeBalance={25}
          networkType="mainnet"
          onChange={onChange}
        />,
      );
      onChange.mockClear();
      rerender(
        <GasPrioritySelector
          nativeBalance={25}
          networkType="testnet"
          onChange={onChange}
        />,
      );
      expectUnassigned(onChange);
      await act(async () => {
        mainnet.resolve(response(222222));
      });
      expectUnassigned(onChange);
      await act(async () => {
        testnet.resolve(response(333333));
      });
      expect(latest(onChange)).toMatchObject({
        networkType: "testnet",
        sourceLedger: "333333",
        isStale: false,
      });
    });

    it.each(["success", "failure"])(
      "ignores a cancelled old-context %s after the new sample loads",
      async (outcome) => {
        const oldRequest = heldResponse();
        const currentRequest = heldResponse();
        global.fetch = vi
          .fn()
          .mockResolvedValueOnce(response())
          .mockReturnValueOnce(oldRequest.promise)
          .mockReturnValueOnce(currentRequest.promise);
        const { rerender, onChange } = await renderLoaded();
        rerender(
          <GasPrioritySelector
            nativeBalance={25}
            networkType="mainnet"
            onChange={onChange}
          />,
        );
        rerender(
          <GasPrioritySelector
            nativeBalance={25}
            networkType="mainnet"
            customHorizonUrl="https://current.example"
            onChange={onChange}
          />,
        );
        await act(async () => {
          currentRequest.resolve(response(333333));
        });
        const sample = latest(onChange);
        const calls = onChange.mock.calls.length;
        await act(async () => {
          if (outcome === "success") oldRequest.resolve(response(222222));
          else oldRequest.reject(new Error("Old source failure"));
        });
        expect(onChange).toHaveBeenCalledTimes(calls);
        expect(latest(onChange)).toEqual(sample);
        expect(sample).toMatchObject({
          sourceLedger: "333333",
          payload: { horizonUrl: "https://current.example" },
        });
        expect(screen.queryByTestId("fee-warning-alert")).toBeNull();
      },
    );

    it("does not reactivate a sample from the preceding supported context", async () => {
      const pending = heldResponse();
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce(response())
        .mockReturnValueOnce(pending.promise);
      const { rerender, onChange } = await renderLoaded();
      rerender(
        <GasPrioritySelector
          nativeBalance={25}
          isUnsupported
          onChange={onChange}
        />,
      );
      expect(global.fetch).toHaveBeenCalledTimes(1);
      onChange.mockClear();
      rerender(<GasPrioritySelector nativeBalance={25} onChange={onChange} />);
      expectUnassigned(onChange);
      await act(async () => {
        pending.resolve(response(222222));
      });
      expect(latest(onChange)).toMatchObject({
        sourceLedger: "222222",
        isStale: false,
        isUnsupported: false,
      });
    });
  });

  describe("Stellar fee expiry while mounted", () => {
    async function renderTimedSelector(props = {}) {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-03T12:00:00.000Z"));
      let ledger = 5432100;
      global.fetch = vi.fn().mockImplementation(async (url) =>
        new Response(
          JSON.stringify(
            String(url).includes("fee_stats")
              ? { last_ledger: ledger++, last_ledger_base_fee: 120 }
              : { result: "0x5d21dba00" },
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      const onChange = vi.fn();
      let view;
      await act(async () => {
        view = render(<GasPrioritySelector {...props} onChange={onChange} />);
      });
      return { ...view, onChange };
    }

    async function advanceTime(ms) {
      await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    }

    function latest(onChange) {
      return onChange.mock.calls[onChange.mock.calls.length - 1][0];
    }

    it.each(["testnet", "mainnet"])(
      "expires the idle %s sample at 60 seconds in both the UI and parent payload",
      async (networkType) => {
        const { onChange } = await renderTimedSelector({ networkType });
        await advanceTime(59_999);
        expect(screen.getByTestId("metric-freshness")).toHaveTextContent("Live rate");
        expect(latest(onChange)).toMatchObject({ isStale: false, payload: { isStale: false } });

        await advanceTime(1);
        expect(screen.getByTestId("metric-freshness")).toHaveTextContent("Stale data");
        expect(screen.getByTestId("fee-warning-alert")).toBeInTheDocument();
        expect(latest(onChange)).toMatchObject({
          isStale: true,
          payload: { isStale: true, ageMs: 60_000, sourceLedger: "5432100" },
        });
        expect(global.fetch).toHaveBeenCalledTimes(1);
      },
    );

    it("keeps a refreshed sample fresh through the old deadline and expires at its own deadline", async () => {
      const { onChange } = await renderTimedSelector();
      await advanceTime(30_000);
      await act(async () => { fireEvent.click(screen.getByTestId("refresh-fees-btn")); });
      const refreshedAt = latest(onChange).freshness;
      expect(latest(onChange).sourceLedger).toBe("5432101");

      await advanceTime(30_000);
      expect(screen.getByTestId("metric-freshness")).toHaveTextContent("Live rate");
      expect(latest(onChange).isStale).toBe(false);
      await advanceTime(29_999);
      expect(latest(onChange).payload.isStale).toBe(false);
      await advanceTime(1);
      expect(screen.getByTestId("metric-freshness")).toHaveTextContent("Stale data");
      expect(latest(onChange)).toMatchObject({
        freshness: refreshedAt,
        isStale: true,
        payload: { isStale: true, ageMs: 60_000, sourceLedger: "5432101" },
      });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it("restores freshness after an expired sample is refreshed", async () => {
      const { onChange } = await renderTimedSelector();
      await advanceTime(60_000);
      expect(latest(onChange).payload.isStale).toBe(true);
      await act(async () => { fireEvent.click(screen.getByTestId("refresh-fees-btn")); });
      expect(screen.getByTestId("metric-freshness")).toHaveTextContent("Live rate");
      expect(latest(onChange)).toMatchObject({
        isStale: false,
        payload: { isStale: false, ageMs: 0, sourceLedger: "5432101" },
      });
      await advanceTime(59_999);
      expect(latest(onChange).payload.isStale).toBe(false);
      await advanceTime(1);
      expect(latest(onChange).payload.isStale).toBe(true);
    });

    it.each(["unsupported", "avalanche"])(
      "stops the Stellar deadline when the selector becomes %s",
      async (state) => {
        const { onChange, rerender } = await renderTimedSelector();
        await advanceTime(30_000);
        await act(async () => {
          rerender(
            <GasPrioritySelector
              network={state === "avalanche" ? "avalanche" : "stellar"}
              isUnsupported={state === "unsupported"}
              onChange={onChange}
            />,
          );
        });
        const calls = onChange.mock.calls.length;
        expect(screen.getByTestId("metric-freshness")).toHaveTextContent(
          state === "unsupported" ? "Unsupported" : "Live rate",
        );
        await advanceTime(60_000);
        expect(onChange).toHaveBeenCalledTimes(calls);
        expect(latest(onChange).network).toBe(state === "avalanche" ? "Avalanche" : "Stellar");
      },
    );

    it("clears a pending deadline when the selector is unmounted", async () => {
      const { unmount } = await renderTimedSelector();
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
