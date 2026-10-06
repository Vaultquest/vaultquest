import { describe, it, expect, afterEach } from "vitest";
import {
  areAccountTestFixturesAllowed,
  hasAccountTestFixtureRuntimeFlag,
  parseAccountTestFixtures,
  resolveAccountWalletState,
} from "./account-wallet-state.js";

const SUPPORTED = [43114, 43113];

describe("areAccountTestFixturesAllowed", () => {
  it("allows fixtures outside production", () => {
    expect(areAccountTestFixturesAllowed({ NODE_ENV: "development" })).toBe(true);
    expect(areAccountTestFixturesAllowed({ NODE_ENV: "test" })).toBe(true);
  });

  it("blocks fixtures in production by default", () => {
    expect(areAccountTestFixturesAllowed({ NODE_ENV: "production" })).toBe(false);
  });

  it("allows fixtures in production when the explicit flag is set", () => {
    expect(
      areAccountTestFixturesAllowed({
        NODE_ENV: "production",
        NEXT_PUBLIC_ALLOW_ACCOUNT_TEST_FIXTURES: "true",
      }),
    ).toBe(true);
  });
});

describe("hasAccountTestFixtureRuntimeFlag", () => {
  afterEach(() => {
    delete window.__VQ_ALLOW_ACCOUNT_TEST_FIXTURES__;
  });

  it("is false without the window flag", () => {
    expect(hasAccountTestFixtureRuntimeFlag(window)).toBe(false);
  });

  it("is true when Playwright injects the runtime flag", () => {
    window.__VQ_ALLOW_ACCOUNT_TEST_FIXTURES__ = true;
    expect(hasAccountTestFixtureRuntimeFlag(window)).toBe(true);
  });
});

describe("parseAccountTestFixtures", () => {
  it("ignores hostile production query strings when fixtures are disallowed", () => {
    const result = parseAccountTestFixtures(
      "?mockConnected=true&networkMismatch=true",
      { fixturesAllowed: false, runtimeFlag: false },
    );
    expect(result).toEqual({
      mockConnected: false,
      networkMismatch: false,
      applied: false,
    });
  });

  it("applies fixtures when development boundary is open", () => {
    expect(
      parseAccountTestFixtures("mockConnected=true", {
        fixturesAllowed: true,
        runtimeFlag: false,
      }),
    ).toEqual({
      mockConnected: true,
      networkMismatch: false,
      applied: true,
    });
  });

  it("applies fixtures when the E2E runtime flag is set", () => {
    expect(
      parseAccountTestFixtures("?networkMismatch=true", {
        fixturesAllowed: false,
        runtimeFlag: true,
      }),
    ).toEqual({
      mockConnected: false,
      networkMismatch: true,
      applied: true,
    });
  });

  it("does not treat unrelated query values as fixtures", () => {
    expect(
      parseAccountTestFixtures("mockConnected=1&networkMismatch=yes", {
        fixturesAllowed: true,
      }),
    ).toEqual({
      mockConnected: false,
      networkMismatch: false,
      applied: true,
    });
  });
});

describe("resolveAccountWalletState", () => {
  it("does not report an interrupted connection before the first connection", () => {
    const state = resolveAccountWalletState({
      wagmiConnected: false,
      supportedChainIds: SUPPORTED,
    });
    expect(state.isConnected).toBe(false);
    expect(state.isNetworkMismatch).toBe(false);
    expect(state.wasDisconnected).toBe(false);
  });

  it("shows reconnect after an observed provider connection is lost", () => {
    const state = resolveAccountWalletState({
      wagmiConnected: false,
      hasConnected: true,
      chainId: null,
      supportedChainIds: SUPPORTED,
    });
    expect(state.isConnected).toBe(false);
    expect(state.isNetworkMismatch).toBe(false);
    expect(state.wasDisconnected).toBe(true);
  });

  it("connects from the wallet provider without fixtures", () => {
    const state = resolveAccountWalletState({
      wagmiConnected: true,
      chainId: 43113,
      supportedChainIds: SUPPORTED,
    });
    expect(state.isConnected).toBe(true);
    expect(state.isNetworkMismatch).toBe(false);
    expect(state.source.providerMismatch).toBe(false);
  });

  it("derives network mismatch from the live chain id", () => {
    const state = resolveAccountWalletState({
      wagmiConnected: true,
      chainId: 1,
      supportedChainIds: SUPPORTED,
    });
    expect(state.isConnected).toBe(true);
    expect(state.isNetworkMismatch).toBe(true);
    expect(state.source.providerMismatch).toBe(true);
  });

  it("ignores fixture bits that were not applied (production hostile URLs)", () => {
    const state = resolveAccountWalletState({
      wagmiConnected: false,
      chainId: null,
      supportedChainIds: SUPPORTED,
      fixtures: {
        mockConnected: true,
        networkMismatch: true,
        applied: false,
      },
    });
    expect(state.isConnected).toBe(false);
    expect(state.isNetworkMismatch).toBe(false);
    expect(state.source.fixtureConnected).toBe(false);
  });

  it("honors applied E2E mockConnected fixture", () => {
    const state = resolveAccountWalletState({
      wagmiConnected: false,
      fixtures: { mockConnected: true, networkMismatch: false, applied: true },
    });
    expect(state.isConnected).toBe(true);
    expect(state.wasDisconnected).toBe(false);
  });

  it("honors applied E2E networkMismatch fixture", () => {
    const state = resolveAccountWalletState({
      wagmiConnected: true,
      chainId: 43113,
      supportedChainIds: SUPPORTED,
      fixtures: { mockConnected: false, networkMismatch: true, applied: true },
    });
    expect(state.isNetworkMismatch).toBe(true);
    expect(state.source.fixtureMismatch).toBe(true);
  });
});
