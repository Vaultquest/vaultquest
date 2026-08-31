import { type Page } from "@playwright/test";
import { injectMockWallet } from "./wallet-mock";

export async function mockAppShell(page: Page, { connected = false } = {}) {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);

    window.localStorage.clear();
    window.sessionStorage.clear();

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = typeof input === "string" ? { url: input, method: init?.method ?? "GET" } : input;
      const url = request.url;
      const method = (init?.method ?? request.method ?? "GET").toUpperCase();

      if (method === "HEAD") {
        return new Response("", { status: 200, statusText: "OK" });
      }

      if (url.includes("api.avax.network/ext/bc/C/rpc") && method === "POST") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: "0x5d21dba00",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      if (url.includes("horizon.stellar.org/fee_stats")) {
        return new Response(
          JSON.stringify({
            last_ledger_base_fee: 100,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      if (url.includes("/api/health")) {
        // Same-origin health probe (#116): the banner reads this JSON and
        // hides when every probe reports operational, so the mock must return
        // a well-formed probe payload rather than an empty body.
        const now = new Date().toISOString();
        const probe = {
          status: "operational",
          checked_at: now,
          checks: [
            {
              id: "stellar-horizon",
              name: "Stellar Horizon API",
              url: "https://horizon.stellar.org",
              status: "operational",
              latency_ms: 120,
            },
            {
              id: "stellar-rpc",
              name: "Stellar RPC",
              url: "https://soroban-testnet.stellar.org",
              status: "operational",
              latency_ms: 210,
            },
            {
              id: "avalanche-rpc",
              name: "Avalanche RPC",
              url: "https://api.avax.network/ext/bc/C/rpc",
              status: "operational",
              latency_ms: 340,
            },
            {
              id: "backend",
              name: "VaultQuest Backend",
              url: "/health/probe",
              status: "operational",
              latency_ms: 18,
            },
          ],
        };
        return new Response(JSON.stringify(probe), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      return originalFetch(input, init);
    };
  });

  if (connected) {
    await injectMockWallet(page, "0x1234567890123456789012345678901234567890");
  } else {
    await page.addInitScript(() => {
      Object.defineProperty(window, "ethereum", {
        configurable: true,
        value: undefined,
      });
    });
  }
}
