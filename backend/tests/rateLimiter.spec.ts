import { describe, expect, it } from "vitest";
import {
  BoundedMemoryRateLimiterStore,
  HybridRateLimiterStore,
  getCanonicalClientIp,
  isTrustedProxy,
  normalizeIp,
  rateLimiter,
  resolveRateLimitKey,
  type RateLimiterStore
} from "../src/middleware/rateLimiter.js";
import Fastify from "fastify";

describe("Distributed Rate Limiter & Trusted Proxy Policy (Issue #96)", () => {
  describe("IP Normalization & Trusted Proxy Parsing", () => {
    it("strips IPv4-mapped IPv6 prefixes (::ffff:192.0.2.1 → 192.0.2.1)", () => {
      expect(normalizeIp("::ffff:192.0.2.1")).toBe("192.0.2.1");
      expect(normalizeIp("192.0.2.1")).toBe("192.0.2.1");
    });

    it("normalizes IPv6 address strings into lowercase canonical form", () => {
      expect(normalizeIp("2001:DB8:0:0:0:0:0:1")).toBe("2001:db8:0:0:0:0:0:1");
      expect(normalizeIp("2001:db8::1")).toBe("2001:db8::1");
    });

    it("identifies trusted proxies correctly", () => {
      const trusted = ["127.0.0.1", "::1", "loopback", "10.0.0.1"];
      expect(isTrustedProxy("127.0.0.1", trusted)).toBe(true);
      expect(isTrustedProxy("::ffff:127.0.0.1", trusted)).toBe(true);
      expect(isTrustedProxy("10.0.0.1", trusted)).toBe(true);
      expect(isTrustedProxy("198.51.100.42", trusted)).toBe(false);
    });

    it("ignores X-Forwarded-For spoofing when direct socket IP is untrusted", () => {
      const mockReq = {
        ip: "198.51.100.42", // Untrusted external IP
        headers: {
          "x-forwarded-for": "203.0.113.195, 10.0.0.1" // Attempted spoofing header
        },
        raw: { socket: { remoteAddress: "198.51.100.42" } }
      } as any;

      const clientIp = getCanonicalClientIp(mockReq, ["127.0.0.1", "10.0.0.1"]);
      // Should reject X-Forwarded-For header because socket IP is not a trusted proxy
      expect(clientIp).toBe("198.51.100.42");
    });

    it("extracts true client IP from X-Forwarded-For when socket IP is a trusted proxy", () => {
      const mockReq = {
        ip: "10.0.0.1", // Trusted load balancer
        headers: {
          "x-forwarded-for": "203.0.113.195, 10.0.0.1"
        },
        raw: { socket: { remoteAddress: "10.0.0.1" } }
      } as any;

      const clientIp = getCanonicalClientIp(mockReq, ["127.0.0.1", "10.0.0.1"]);
      // Steps back from 10.0.0.1 (trusted) to 203.0.113.195 (client)
      expect(clientIp).toBe("203.0.113.195");
    });
  });

  describe("Principal-Aware Key Resolution", () => {
    it("keys by authenticated wallet address when x-wallet-address header is present", () => {
      const mockReq = {
        method: "POST",
        ip: "198.51.100.42",
        headers: { "x-wallet-address": "GABC1234567890XYZ" }
      } as any;

      const { key, isPrincipal } = resolveRateLimitKey(mockReq, ["127.0.0.1"]);
      expect(isPrincipal).toBe(true);
      expect(key).toBe("sensitive:wallet:GABC1234567890XYZ");
    });

    it("keys by API key hash when x-api-key header is present", () => {
      const mockReq = {
        method: "GET",
        ip: "198.51.100.42",
        headers: { "x-api-key": "my-secret-production-api-key-value" }
      } as any;

      const { key, isPrincipal } = resolveRateLimitKey(mockReq, ["127.0.0.1"]);
      expect(isPrincipal).toBe(true);
      expect(key.startsWith("public:apikey:")).toBe(true);
    });

    it("falls back to canonical client IP when no principal is present", () => {
      const mockReq = {
        method: "GET",
        ip: "198.51.100.42",
        headers: {}
      } as any;

      const { key, isPrincipal } = resolveRateLimitKey(mockReq, ["127.0.0.1"]);
      expect(isPrincipal).toBe(false);
      expect(key).toBe("public:ip:198.51.100.42");
    });
  });

  describe("Bounded Memory Store & Multi-Instance Counter Sharing", () => {
    it("bounds local memory capacity and evicts oldest entry on overflow", async () => {
      const store = new BoundedMemoryRateLimiterStore(3);

      await store.increment("key-1", 10, 60000);
      await store.increment("key-2", 10, 60000);
      await store.increment("key-3", 10, 60000);
      expect(store.size).toBe(3);

      // Overflow max entries (3)
      await store.increment("key-4", 10, 60000);
      expect(store.size).toBe(3);
    });

    it("shares state across multiple instances when backed by a shared store", async () => {
      class SharedMockStore implements RateLimiterStore {
        private readonly map = new Map<string, number>();

        async increment(key: string, limit: number, windowMs: number) {
          const count = (this.map.get(key) || 0) + 1;
          this.map.set(key, count);
          return {
            allowed: count <= limit,
            current: count,
            remaining: Math.max(0, limit - count),
            resetTimeMs: Date.now() + windowMs
          };
        }
      }

      const sharedStore = new SharedMockStore();

      // Instance 1
      const app1 = Fastify();
      app1.get("/health", async () => "ok");
      await app1.register(rateLimiter, { store: sharedStore });

      // Instance 2
      const app2 = Fastify();
      app2.get("/health", async () => "ok");
      await app2.register(rateLimiter, { store: sharedStore });

      // Request on Instance 1
      const res1 = await app1.inject({ method: "GET", url: "/health" });
      expect(res1.statusCode).toBe(200);

      // Request on Instance 2 (should see count = 2 from shared store)
      const res2 = await app2.inject({ method: "GET", url: "/health" });
      expect(res2.statusCode).toBe(200);
      expect(res2.headers["x-ratelimit-remaining"]).toBe("98");

      await app1.close();
      await app2.close();
    });

    it("degrades safely to local bounded store during store outages", async () => {
      class FailingStore implements RateLimiterStore {
        async increment() {
          throw new Error("Database/Redis connection timeout");
        }
      }

      const hybridStore = new HybridRateLimiterStore();
      // Inject failing primary store
      (hybridStore as any).redisStore = new FailingStore();

      // Increments should not throw; falls back to local memory store
      const result = await hybridStore.increment("test-fallback-key", 10, 60000);
      expect(result.allowed).toBe(true);
      expect(result.current).toBe(1);
    });
  });
});
