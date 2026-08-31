import { describe, it, expect } from "vitest";
import { parseEnv } from "../src/env.js";

describe("parseEnv", () => {
  it("accepts valid env with API_KEY", () => {
    const env = parseEnv({
      DATABASE_URL: "postgres://u:p@localhost:5432/db",
      INTERNAL_SERVICE_SECRET: "a-very-long-shared-secret-value-123",
      API_KEY: "a".repeat(32),
      ORPHAN_TTL_MINUTES: "10",
      LOG_LEVEL: "info"
    });
    expect(env.DATABASE_URL).toBe("postgres://u:p@localhost:5432/db");
    expect(env.ORPHAN_TTL_MINUTES).toBe(10);
    expect(env.API_KEY).toBe("a".repeat(32));
  });

  it("accepts dev env with explicit ALLOW_UNAUTHENTICATED_DEV_API opt-in", () => {
    const env = parseEnv({
      DATABASE_URL: "postgres://u:p@localhost:5432/db",
      INTERNAL_SERVICE_SECRET: "a-very-long-shared-secret-value-123",
      ALLOW_UNAUTHENTICATED_DEV_API: "true",
      NODE_ENV: "development"
    });
    expect(env.ALLOW_UNAUTHENTICATED_DEV_API).toBe(true);
  });

  it("rejects dev env without API_KEY and without ALLOW_UNAUTHENTICATED_DEV_API", () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: "postgres://u:p@localhost:5432/db",
        INTERNAL_SERVICE_SECRET: "a-very-long-shared-secret-value-123",
        NODE_ENV: "development"
      })
    ).toThrow(/API_KEY is required/);
  });

  it("rejects production env missing API_KEY", () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: "postgres://u:p@localhost:5432/db",
        INTERNAL_SERVICE_SECRET: "a-very-long-shared-secret-value-123",
        NODE_ENV: "production"
      })
    ).toThrow(/API_KEY is required in production/);
  });

  it("rejects production env attempting ALLOW_UNAUTHENTICATED_DEV_API bypass", () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: "postgres://u:p@localhost:5432/db",
        INTERNAL_SERVICE_SECRET: "a-very-long-shared-secret-value-123",
        API_KEY: "a".repeat(32),
        ALLOW_UNAUTHENTICATED_DEV_API: "true",
        NODE_ENV: "production"
      })
    ).toThrow(/ALLOW_UNAUTHENTICATED_DEV_API cannot be enabled in production/);
  });

  it("defaults ORPHAN_TTL_MINUTES to 10 when ALLOW_UNAUTHENTICATED_DEV_API is set", () => {
    const env = parseEnv({
      DATABASE_URL: "postgres://u:p@localhost:5432/db",
      INTERNAL_SERVICE_SECRET: "a-very-long-shared-secret-value-123",
      ALLOW_UNAUTHENTICATED_DEV_API: "true"
    });
    expect(env.ORPHAN_TTL_MINUTES).toBe(10);
  });
});

