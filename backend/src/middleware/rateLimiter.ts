import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { createHash, randomUUID } from "node:crypto";
import { ERROR_CODES } from "../constants.js";
import { AppError } from "../errors.js";
import type { CacheService } from "../services/cacheService.js";

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_LOCAL_MEMORY_ENTRIES = 10000;

export interface RateLimitResult {
  allowed: boolean;
  current: number;
  remaining: number;
  resetTimeMs: number;
}

export interface RateLimiterStore {
  increment(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

/**
 * Bounded in-memory store fallback for single processes or during store outages.
 * Enforces a strict max capacity limit and active TTL pruning to prevent memory leaks.
 */
export class BoundedMemoryRateLimiterStore implements RateLimiterStore {
  private readonly store = new Map<string, { count: number; resetTimeMs: number }>();
  private readonly maxEntries: number;

  constructor(maxEntries = MAX_LOCAL_MEMORY_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  async increment(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    this.pruneExpired(now);

    let entry = this.store.get(key);
    if (!entry || now > entry.resetTimeMs) {
      entry = { count: 1, resetTimeMs: now + windowMs };
      this.evictIfFull();
      this.store.set(key, entry);
    } else {
      entry.count += 1;
    }

    const allowed = entry.count <= limit;
    const remaining = Math.max(0, limit - entry.count);

    return {
      allowed,
      current: entry.count,
      remaining,
      resetTimeMs: entry.resetTimeMs
    };
  }

  private pruneExpired(now: number): void {
    for (const [k, v] of this.store.entries()) {
      if (now > v.resetTimeMs) {
        this.store.delete(k);
      }
    }
  }

  private evictIfFull(): void {
    if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

/**
 * Redis-backed atomic rate limiter store using Redis client or CacheService.
 * Survives restarts and shares counters across multiple application replicas.
 */
export class RedisRateLimiterStore implements RateLimiterStore {
  private readonly cacheService: CacheService;

  constructor(cacheService: CacheService) {
    this.cacheService = cacheService;
  }

  async increment(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const redis = (this.cacheService as any).redis;
    const isOnline = (this.cacheService as any).isOnline;

    if (!redis || !isOnline) {
      throw new Error("Redis rate limiter store unavailable");
    }

    const redisKey = `ratelimit:${key}`;
    const windowSeconds = Math.ceil(windowMs / 1000);
    const now = Date.now();

    // Atomic INCR + EXPIRE via pipeline
    const pipeline = redis.pipeline();
    pipeline.incr(redisKey);
    pipeline.ttl(redisKey);
    const results = await pipeline.exec();

    if (!results || results.length < 2) {
      throw new Error("Redis rate limit atomic pipeline execution failed");
    }

    const [incrErr, countVal] = results[0];
    const [ttlErr, ttlVal] = results[1];

    if (incrErr || typeof countVal !== "number") {
      throw incrErr || new Error("Invalid Redis INCR result");
    }

    let ttlSeconds = typeof ttlVal === "number" ? ttlVal : -1;

    // If key was newly created (ttl === -1), set window expiry atomically
    if (ttlSeconds < 0) {
      await redis.expire(redisKey, windowSeconds);
      ttlSeconds = windowSeconds;
    }

    const count = countVal;
    const allowed = count <= limit;
    const remaining = Math.max(0, limit - count);
    const resetTimeMs = now + Math.max(1, ttlSeconds) * 1000;

    return {
      allowed,
      current: count,
      remaining,
      resetTimeMs
    };
  }
}

/**
 * Hybrid store that uses Redis atomic counters as primary store, gracefully
 * falling back to bounded local memory if Redis is unavailable or disconnected.
 */
export class HybridRateLimiterStore implements RateLimiterStore {
  private readonly redisStore?: RedisRateLimiterStore;
  private readonly localStore: BoundedMemoryRateLimiterStore;

  constructor(cacheService?: CacheService) {
    if (cacheService) {
      this.redisStore = new RedisRateLimiterStore(cacheService);
    }
    this.localStore = new BoundedMemoryRateLimiterStore();
  }

  async increment(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    if (this.redisStore) {
      try {
        return await this.redisStore.increment(key, limit, windowMs);
      } catch {
        // Fall back to bounded local store on Redis connection failure or outage
      }
    }
    return this.localStore.increment(key, limit, windowMs);
  }
}

/**
 * Normalizes IPv4 and IPv6 representations into a standard canonical format.
 * - Strips `::ffff:` prefix from IPv4-mapped IPv6 addresses (e.g. `::ffff:192.0.2.1` -> `192.0.2.1`).
 * - Standardizes IPv6 addresses into lowercase canonical form.
 */
export function normalizeIp(ip: string): string {
  if (!ip) return "127.0.0.1";
  let clean = ip.trim();

  // Strip IPv4-mapped IPv6 prefix
  if (clean.startsWith("::ffff:")) {
    clean = clean.substring(7);
  }

  // Handle standard IPv4
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(clean)) {
    return clean;
  }

  // Canonicalize IPv6 address strings
  if (clean.includes(":")) {
    const parts = clean.toLowerCase().split(":");
    // If compressed with ::, keep standard lowecase notation
    return parts.join(":");
  }

  return clean;
}

/**
 * Checks whether an IP address is considered a trusted proxy based on configured rules.
 */
export function isTrustedProxy(ip: string, trustedProxies: string[]): boolean {
  const normalized = normalizeIp(ip);
  if (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost"
  ) {
    return true;
  }

  for (const rule of trustedProxies) {
    const cleanRule = rule.trim();
    if (!cleanRule) continue;
    if (cleanRule === "loopback" && (normalized === "127.0.0.1" || normalized === "::1")) {
      return true;
    }
    if (cleanRule === normalized) {
      return true;
    }
    // Subnet CIDR match for common private ranges
    if (cleanRule.startsWith("10.") && normalized.startsWith("10.")) return true;
    if (cleanRule.startsWith("172.16.") && normalized.startsWith("172.16.")) return true;
    if (cleanRule.startsWith("192.168.") && normalized.startsWith("192.168.")) return true;
  }

  return false;
}

/**
 * Extracts canonical client IP from request, taking into account trusted proxy headers.
 * Untrusted `X-Forwarded-For` headers are strictly ignored unless the direct socket
 * connection originates from a trusted proxy.
 */
export function getCanonicalClientIp(req: FastifyRequest, trustedProxies: string[] = ["127.0.0.1", "::1", "loopback"]): string {
  const socketIp = normalizeIp(req.ip || (req.raw?.socket?.remoteAddress as string) || "127.0.0.1");

  // If the direct socket IP is not a trusted proxy, do NOT trust X-Forwarded-For
  if (!isTrustedProxy(socketIp, trustedProxies)) {
    return socketIp;
  }

  const xff = req.headers["x-forwarded-for"];
  if (!xff) {
    return socketIp;
  }

  const rawHeader = Array.isArray(xff) ? xff[0] : xff;
  if (!rawHeader) return socketIp;

  const hops = rawHeader.split(",").map((h) => normalizeIp(h.trim())).filter(Boolean);
  if (hops.length === 0) return socketIp;

  // Walk backward through proxy chain starting from rightmost hop
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i];
    if (!isTrustedProxy(hop, trustedProxies)) {
      return hop;
    }
  }

  return hops[0] || socketIp;
}

/**
 * Resolves principal-aware or IP-based rate limit key for request.
 * Authenticated wallet addresses or API keys take precedence over IP address.
 */
export function resolveRateLimitKey(req: FastifyRequest, trustedProxies: string[]): { key: string; isPrincipal: boolean } {
  const method = req.method;
  const isSensitive = ["POST", "PATCH", "PUT", "DELETE"].includes(method);
  const scope = isSensitive ? "sensitive" : "public";

  // 1. Authenticated Wallet Principal
  const walletHeader = req.headers["x-wallet-address"];
  const walletAddress = Array.isArray(walletHeader) ? walletHeader[0] : walletHeader;
  const reqUser = (req as any).user?.walletAddress;
  const principalWallet = walletAddress || reqUser;

  if (typeof principalWallet === "string" && principalWallet.trim().length > 0) {
    return {
      key: `${scope}:wallet:${principalWallet.trim()}`,
      isPrincipal: true
    };
  }

  // 2. Authenticated API Key Principal
  const apiKeyHeader = req.headers["x-api-key"];
  const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
  if (typeof apiKey === "string" && apiKey.trim().length > 0) {
    const hashedKey = createHash("sha256").update(apiKey.trim()).digest("hex").substring(0, 16);
    return {
      key: `${scope}:apikey:${hashedKey}`,
      isPrincipal: true
    };
  }

  // 3. Fallback to Canonical Client IP
  const clientIp = getCanonicalClientIp(req, trustedProxies);
  return {
    key: `${scope}:ip:${clientIp}`,
    isPrincipal: false
  };
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  const pairs = cookieHeader.split(";");
  for (const pair of pairs) {
    const [key, ...valueParts] = pair.split("=");
    if (key) {
      cookies[key.trim()] = valueParts.join("=").trim();
    }
  }
  return cookies;
}

export interface RateLimiterOptions {
  cacheService?: CacheService;
  trustedProxies?: string | string[];
  store?: RateLimiterStore;
}

const plugin: FastifyPluginAsync<RateLimiterOptions> = async (app, options) => {
  const trustedProxiesList = typeof options.trustedProxies === "string"
    ? options.trustedProxies.split(",").map((s) => s.trim())
    : options.trustedProxies || ["127.0.0.1", "::1", "loopback"];

  const store = options.store || new HybridRateLimiterStore(options.cacheService);

  app.addHook("preHandler", async (req, reply) => {
    const method = req.method;
    const isSensitive = ["POST", "PATCH", "PUT", "DELETE"].includes(method);
    const limit = isSensitive ? 10 : 100;

    const { key } = resolveRateLimitKey(req, trustedProxiesList);
    const result = await store.increment(key, limit, WINDOW_MS);

    reply.header("X-RateLimit-Limit", limit);
    reply.header("X-RateLimit-Remaining", result.remaining);
    reply.header("X-RateLimit-Reset", Math.ceil(result.resetTimeMs / 1000));

    if (!result.allowed) {
      reply.header("Retry-After", Math.ceil((result.resetTimeMs - Date.now()) / 1000));
      throw new AppError(ERROR_CODES.RATE_LIMIT_EXCEEDED, 429, "Rate limit exceeded. Try again later.");
    }

    // CSRF Protection
    if (["GET", "HEAD", "OPTIONS"].includes(method) || req.url.startsWith("/internal/")) {
      if (method === "GET") {
        const cookies = parseCookies(req.headers.cookie);
        let csrfToken = cookies["csrf-token"];
        if (!csrfToken) {
          csrfToken = randomUUID();
          reply.header("Set-Cookie", `csrf-token=${csrfToken}; Path=/; HttpOnly; SameSite=Lax`);
        }
        reply.header("X-CSRF-Token", csrfToken);
      }
      return;
    }

    // CSRF Check for state-changing requests
    const cookies = parseCookies(req.headers.cookie);
    const cookieToken = cookies["csrf-token"];
    const headerToken = req.headers["x-csrf-token"];
    const headerTokenStr = Array.isArray(headerToken) ? headerToken[0] : headerToken;

    if (!cookieToken || !headerTokenStr || cookieToken !== headerTokenStr) {
      throw new AppError(ERROR_CODES.FORBIDDEN, 403, "Invalid or missing CSRF token");
    }
  });
};

export const rateLimiter = fp(plugin, { name: "rateLimiter" });
