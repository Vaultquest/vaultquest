const WALLET_HEADERS = ["x-wallet-address", "x-wallet-signature", "x-wallet-timestamp"];
const NO_STORE = { "Cache-Control": "no-store" };

function failure(status, code, message) {
  return Response.json({ error: { code, message } }, { status, headers: NO_STORE });
}

/** Forward the caller's proof; never turn a supplied wallet into a service principal. */
export async function forwardWalletNotification(req, path, {
  fetchImpl = fetch,
  backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001",
} = {}) {
  if (!["/notification-prefs", "/notifications"].includes(path) || !["GET", "PUT"].includes(req.method)) {
    return failure(405, "METHOD_NOT_ALLOWED", "Unsupported notification request.");
  }
  const headers = { "Content-Type": "application/json" };
  for (const name of WALLET_HEADERS) {
    const value = req.headers.get(name);
    if (!value) return failure(401, "UNAUTHORIZED", "Sign with the connected wallet to continue.");
    headers[name] = value;
  }

  let body;
  if (req.method === "PUT") {
    try {
      body = JSON.stringify(await req.json());
      if (body.length > 8192) return failure(413, "PAYLOAD_TOO_LARGE", "Preferences are too large.");
    } catch {
      return failure(400, "INVALID_PAYLOAD", "Invalid preferences request.");
    }
  }

  try {
    const baseUrl = backendUrl.replace(/\/$/, "");
    // The existing backend requires its own cookie/token pair on mutations.
    // Obtain it without a wallet signature so the single-use proof is consumed
    // only by the intended PUT. No service credential is introduced here.
    if (req.method === "PUT") {
      const csrf = await fetchImpl(`${baseUrl}/health`, {
        method: "GET",
        // Preserve the existing per-wallet rate-limit bucket without sending
        // or consuming the single-use proof on this public bootstrap request.
        headers: { "x-wallet-address": headers["x-wallet-address"] },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      });
      const token = csrf.headers.get("x-csrf-token");
      const cookie = csrf.headers.get("set-cookie")?.match(/(?:^|,\s*)csrf-token=([^;\s,]+)/)?.[1];
      if (!csrf.ok || !token || cookie !== token) throw new Error("Missing backend CSRF pair");
      headers["x-csrf-token"] = token;
      headers.cookie = `csrf-token=${cookie}`;
    }
    const search = req.method === "GET" ? new URL(req.url).search : "";
    const response = await fetchImpl(`${baseUrl}${path}${search}`, {
      method: req.method,
      headers,
      ...(body === undefined ? {} : { body }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    if (response.ok) {
      const result = await response.json();
      if (!result || !("data" in result)) throw new Error("Invalid backend response");
      return Response.json({ data: result.data }, { headers: NO_STORE });
    }
    const errors = {
      400: ["INVALID_PAYLOAD", "Invalid notification preferences request."],
      401: ["UNAUTHORIZED", "The wallet signature was rejected. Sign again to retry."],
      403: ["FORBIDDEN", "The connected wallet cannot access these preferences."],
      409: ["CONFLICT", "Preferences changed on another device or use a newer format. Reload before saving."],
      429: ["RATE_LIMIT_EXCEEDED", "Too many requests. Retry shortly."],
    };
    const known = errors[response.status];
    return known ? failure(response.status, ...known) : failure(502, "UPSTREAM_ERROR", "Notification service is unavailable.");
  } catch {
    return failure(503, "SERVICE_UNAVAILABLE", "Notification service is unavailable. Retry when online.");
  }
}
