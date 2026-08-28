import { avalanche, avalancheFuji } from "wagmi/chains";

export const RPC_STORAGE_KEY = "vaultquest-custom-rpc";
export const RPC_UPDATED_EVENT = "vaultquest-rpc-updated";

export const DEFAULT_RPC = {
  horizon: "https://horizon-testnet.stellar.org",
  avalanche: avalanche.rpcUrls.default.http[0],
  avalancheFuji: avalancheFuji.rpcUrls.default.http[0],
};

const HORIZON_NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015";

const RPC_FIELD_KEYS = ["horizon", "avalanche", "avalancheFuji"];

// Only these exact hostname literals are treated as "explicit localhost development" –
// obfuscated or partial forms (e.g. decimal/hex encodings) are rejected, not silently allowed.
const LOOPBACK_LITERALS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parseIPv4Literal(hostname) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return null;
  return octets;
}

function isPrivateOrReservedIPv4([a, b, c]) {
  if (a === 0) return true; // "this" network
  if (a === 10) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local / cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function isPrivateOrReservedIPv6(hostname) {
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return false;
  const addr = hostname.slice(1, -1);
  if (addr === "::1" || addr === "::") return true;
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true; // fc00::/7 unique local
  if (["fe8", "fe9", "fea", "feb"].some((p) => addr.startsWith(p))) return true; // fe80::/10 link-local
  return false;
}

/**
 * Validates a user-supplied RPC endpoint URL before it is fetched or persisted.
 * Rejects insecure schemes (except explicit localhost), embedded credentials, and
 * private/reserved network addresses that could be used to reach internal services.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateRpcEndpoint(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: "Enter a valid URL." };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: "URLs with embedded credentials are not allowed." };
  }

  const hostname = parsed.hostname.toLowerCase();
  const isExplicitLoopback = LOOPBACK_LITERALS.has(hostname);

  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isExplicitLoopback)) {
    return {
      ok: false,
      error: "Only HTTPS endpoints are allowed (HTTP is permitted for localhost during development).",
    };
  }

  if (!isExplicitLoopback) {
    const ipv4 = parseIPv4Literal(hostname);
    if (ipv4 && isPrivateOrReservedIPv4(ipv4)) {
      return { ok: false, error: "Private or reserved network addresses are not allowed." };
    }
    if (isPrivateOrReservedIPv6(hostname)) {
      return { ok: false, error: "Private or reserved network addresses are not allowed." };
    }
  }

  return { ok: true };
}

/** @returns {{ horizon: string, avalanche: string, avalancheFuji: string } | null} */
export function readStoredRpc() {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(RPC_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;

    const result = {};
    let needsRewrite = false;
    for (const key of RPC_FIELD_KEYS) {
      const value = typeof parsed[key] === "string" ? parsed[key] : null;
      if (value && validateRpcEndpoint(value).ok) {
        result[key] = value;
      } else {
        result[key] = DEFAULT_RPC[key];
        if (value) needsRewrite = true; // stored value no longer meets safety policy
      }
    }
    if (needsRewrite) {
      localStorage.setItem(RPC_STORAGE_KEY, JSON.stringify(result));
    }
    return result;
  } catch {
    return null;
  }
}

/** @param {{ horizon?: string, avalanche?: string, avalancheFuji?: string }} urls */
export function writeStoredRpc(urls) {
  const current = readStoredRpc() ?? { ...DEFAULT_RPC };
  const next = { ...current };
  for (const key of RPC_FIELD_KEYS) {
    const candidate = urls[key]?.trim();
    if (candidate && validateRpcEndpoint(candidate).ok) {
      next[key] = candidate;
    }
  }
  localStorage.setItem(RPC_STORAGE_KEY, JSON.stringify(next));
  return next;
}

/** Active Horizon URL (custom localStorage override or default). */
export function getHorizonUrl() {
  const stored = readStoredRpc()?.horizon;
  return stored ? normalizeBaseUrl(stored) : DEFAULT_RPC.horizon;
}

function normalizeBaseUrl(url) {
  return url.trim().replace(/\/+$/, "");
}

/** Validates a Stellar Horizon instance via its root endpoint (horizon_version / _links). */
export async function pingHorizon(horizonUrl) {
  const check = validateRpcEndpoint(horizonUrl);
  if (!check.ok) return check;

  const base = normalizeBaseUrl(horizonUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(base, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
      redirect: "manual",
    });
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      return { ok: false, error: "Endpoint redirected to another host; redirects are not allowed." };
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    if (!(data?.horizon_version || data?._links?.account)) {
      return { ok: false, error: "Not a valid Horizon root response" };
    }
    if (data?.network_passphrase && data.network_passphrase !== HORIZON_NETWORK_PASSPHRASE) {
      return {
        ok: false,
        error: `Endpoint is on network "${data.network_passphrase}", expected "${HORIZON_NETWORK_PASSPHRASE}".`,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Connection failed" };
  } finally {
    clearTimeout(timeout);
  }
}

/** Validates an EVM JSON-RPC endpoint and binds it to the expected chain ID (eth_chainId). */
export async function pingEvmRpc(rpcUrl, expectedChainId) {
  const check = validateRpcEndpoint(rpcUrl);
  if (!check.ok) return check;

  const url = normalizeBaseUrl(rpcUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      redirect: "manual",
    });
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      return { ok: false, error: "Endpoint redirected to another host; redirects are not allowed." };
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    if (typeof data?.result !== "string" || !data.result.startsWith("0x")) {
      return { ok: false, error: data?.error?.message ?? "Invalid JSON-RPC response" };
    }
    const chainId = parseInt(data.result, 16);
    if (typeof expectedChainId === "number" && chainId !== expectedChainId) {
      return {
        ok: false,
        error: `Endpoint is on chain ID ${chainId}, expected ${expectedChainId}.`,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Connection failed" };
  } finally {
    clearTimeout(timeout);
  }
}
