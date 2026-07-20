import { describe, expect, it } from "vitest";
import {
  classifyVaultData,
  formatVaultDataAge,
  VAULT_DATA_STALE_AFTER_MS,
  VAULT_DATA_UNAVAILABLE_AFTER_MS,
} from "./vault-data-freshness";

const now = Date.parse("2026-07-20T12:00:00.000Z");

describe("vault data freshness", () => {
  it.each([
    ["fresh", 30_000, false, null],
    ["stale", VAULT_DATA_STALE_AFTER_MS, false, null],
    ["degraded", 30_000, true, null],
    ["unavailable", VAULT_DATA_UNAVAILABLE_AFTER_MS, false, null],
    ["unavailable", 30_000, false, new Error("indexer unavailable")],
  ])("classifies %s data", (status, ageMs, degraded, error) => {
    expect(
      classifyVaultData({
        updatedAt: new Date(now - ageMs).toISOString(),
        degraded,
        error,
        now,
      }).status,
    ).toBe(status);
  });

  it("treats a response without data as unavailable", () => {
    expect(classifyVaultData({ hasData: false, now }).status).toBe("unavailable");
  });

  it("formats measurable update ages", () => {
    expect(formatVaultDataAge(new Date(now - 5 * 60_000), now)).toBe("Updated 5m ago");
  });
});
