/**
 * Account page wallet connection / network state.
 *
 * Production derives connection and mismatch only from wallet providers.
 * URL query overrides (`mockConnected`, `networkMismatch`) are gated behind
 * an explicit development / E2E fixture boundary so hostile query strings
 * cannot forge connected or mismatch UI in production.
 */

/** @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env] */
export function areAccountTestFixturesAllowed(
  // Keep direct property reads: Next cannot inline an alias of process.env.
  env = {
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_ALLOW_ACCOUNT_TEST_FIXTURES:
      process.env.NEXT_PUBLIC_ALLOW_ACCOUNT_TEST_FIXTURES,
  },
) {
  if (env.NODE_ENV !== "production") return true;
  if (env.NEXT_PUBLIC_ALLOW_ACCOUNT_TEST_FIXTURES === "true") return true;
  return false;
}

/**
 * Runtime window flag used by Playwright when the production build was not
 * compiled with NEXT_PUBLIC_ALLOW_ACCOUNT_TEST_FIXTURES.
 * @param {Window | undefined | null} [win]
 */
export function hasAccountTestFixtureRuntimeFlag(win = typeof window !== "undefined" ? window : undefined) {
  return Boolean(win && win.__VQ_ALLOW_ACCOUNT_TEST_FIXTURES__ === true);
}

/**
 * @param {string | URLSearchParams | null | undefined} search
 * @param {{
 *   fixturesAllowed?: boolean,
 *   runtimeFlag?: boolean,
 * }} [options]
 * @returns {{ mockConnected: boolean, networkMismatch: boolean, applied: boolean }}
 */
export function parseAccountTestFixtures(search, options = {}) {
  const fixturesAllowed =
    options.fixturesAllowed ?? areAccountTestFixturesAllowed();
  const runtimeFlag =
    options.runtimeFlag ?? hasAccountTestFixtureRuntimeFlag();

  const allowed = fixturesAllowed || runtimeFlag;
  if (!allowed) {
    return { mockConnected: false, networkMismatch: false, applied: false };
  }

  const params =
    search instanceof URLSearchParams
      ? search
      : new URLSearchParams(
          typeof search === "string"
            ? search.startsWith("?")
              ? search.slice(1)
              : search
            : "",
        );

  return {
    mockConnected: params.get("mockConnected") === "true",
    networkMismatch: params.get("networkMismatch") === "true",
    applied: true,
  };
}

/**
 * Resolve account page connection UI from wallet providers + optional fixtures.
 *
 * @param {{
 *   wagmiConnected: boolean,
 *   hasConnected?: boolean,
 *   chainId?: number | null,
 *   supportedChainIds?: number[],
 *   fixtures?: { mockConnected?: boolean, networkMismatch?: boolean, applied?: boolean },
 * }} input
 */
export function resolveAccountWalletState({
  wagmiConnected,
  hasConnected = false,
  chainId = null,
  supportedChainIds = [],
  fixtures = { mockConnected: false, networkMismatch: false, applied: false },
}) {
  const fixtureConnected = Boolean(fixtures.applied && fixtures.mockConnected);
  const fixtureMismatch = Boolean(fixtures.applied && fixtures.networkMismatch);

  const providerMismatch =
    Boolean(wagmiConnected) &&
    typeof chainId === "number" &&
    supportedChainIds.length > 0 &&
    !supportedChainIds.includes(chainId);

  const isConnected = Boolean(wagmiConnected) || fixtureConnected;
  const isNetworkMismatch = fixtureMismatch || providerMismatch;

  // First paint / never-connected should not look like a disconnect recovery.
  // Only a previously observed provider connection can become disconnected.
  // Fixtures must not establish provider history or hide a mismatch-only view.
  const wasDisconnected = Boolean(hasConnected) && !isConnected && !isNetworkMismatch;

  return {
    isConnected,
    isNetworkMismatch,
    wasDisconnected,
    source: {
      wagmiConnected: Boolean(wagmiConnected),
      fixtureConnected,
      fixtureMismatch,
      providerMismatch,
    },
  };
}
