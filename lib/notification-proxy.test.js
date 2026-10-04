import { describe, expect, it, vi } from "vitest";
import { forwardWalletNotification } from "./notification-proxy.js";

const proof = {
  "x-wallet-address": "synthetic-wallet",
  "x-wallet-signature": "synthetic-proof",
  "x-wallet-timestamp": "12345",
};
const prefs = { wallet_address: "synthetic-wallet", expectedRevision: 1, prefs: { deposits: true } };
const request = (method = "GET", headers = proof, body = prefs) => new Request("http://localhost/api/notification-prefs?wallet=synthetic-wallet", {
  method,
  headers,
  ...(method === "PUT" ? { body: JSON.stringify(body) } : {}),
});
const csrfResponse = () => new Response("{}", { headers: {
  "x-csrf-token": "synthetic-csrf",
  "set-cookie": "csrf-token=synthetic-csrf; Path=/; HttpOnly; SameSite=Lax",
} });

describe("notification proxy", () => {
  it("requires the complete wallet proof without contacting the backend", async () => {
    const fetchImpl = vi.fn();
    const response = await forwardWalletNotification(request("GET", {}), "/notification-prefs", { fetchImpl });
    expect(response.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("forwards only wallet proof and preserves the query and uncached envelope", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ data: { revision: 4 }, private: "omitted" }));
    const response = await forwardWalletNotification(request("GET", { ...proof, "x-api-key": "must-not-forward", "x-internal-secret": "must-not-forward", cookie: "must-not-forward" }), "/notification-prefs", { fetchImpl, backendUrl: "http://backend:3001/" });
    expect(fetchImpl.mock.calls[0][0]).toBe("http://backend:3001/notification-prefs?wallet=synthetic-wallet");
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: "GET", headers: { ...proof, "Content-Type": "application/json" }, cache: "no-store", redirect: "error" });
    expect(Object.keys(fetchImpl.mock.calls[0][1].headers).sort()).toEqual(["Content-Type", ...Object.keys(proof)].sort());
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ data: { revision: 4 } });
  });

  it("obtains the backend CSRF pair without consuming the wallet proof before PUT", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(csrfResponse()).mockResolvedValueOnce(Response.json({ data: { revision: 2 } }));
    const response = await forwardWalletNotification(request("PUT"), "/notification-prefs", { fetchImpl, backendUrl: "http://backend:3001" });
    expect(fetchImpl.mock.calls[0][0]).toBe("http://backend:3001/health");
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({ "x-wallet-address": proof["x-wallet-address"] });
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({
      method: "PUT", body: JSON.stringify(prefs),
      headers: { ...proof, "x-csrf-token": "synthetic-csrf", cookie: "csrf-token=synthetic-csrf" },
    });
    expect(response.status).toBe(200);
  });

  it("stops before PUT if the backend CSRF pair is missing or inconsistent", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { headers: { "x-csrf-token": "mismatch", "set-cookie": "csrf-token=other" } }));
    const response = await forwardWalletNotification(request("PUT"), "/notification-prefs", { fetchImpl });
    expect(response.status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403, 409, 429])("preserves HTTP %i without exposing backend internals", async status => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("database host and sensitive details", { status }));
    const response = await forwardWalletNotification(request(), "/notification-prefs", { fetchImpl });
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("database host");
  });

  it("reports an unavailable service or malformed success without inventing saved data", async () => {
    for (const fetchImpl of [vi.fn().mockRejectedValue(new Error("network")), vi.fn().mockResolvedValue(Response.json({ ok: true }))]) {
      const response = await forwardWalletNotification(request(), "/notification-prefs", { fetchImpl });
      expect(response.status).toBe(503);
      expect(await response.json()).toHaveProperty("error");
    }
  });
});
