import { describe, it, expect } from "vitest";
import { MOCK_VAULTS, VAULT_ROUND_ARCHIVE } from "@/lib/vault-mock-data";
import { ROUND_STATUS, getRoundStatusMeta } from "@/lib/vault-status";

// Mirrors the run-time contract enforced by useVaultDataReview so the seed
// never regresses silently into a data-shape that trips review warnings.
const REQUIRED_FIELDS = [
  { key: "name", type: "string" },
  { key: "apy", type: "number" },
  { key: "minDeposit", type: "number" },
  { key: "status", type: "string" },
  { key: "totalDeposits", type: "number" },
];

describe("MOCK_VAULTS", () => {
  it("provides at least one vault per round lifecycle state", () => {
    const states = new Set(MOCK_VAULTS.map((v) => v.status));
    expect(states).toEqual(
      new Set([
        ROUND_STATUS.ACTIVE,
        ROUND_STATUS.PENDING,
        ROUND_STATUS.COMPLETED,
        ROUND_STATUS.PAUSED,
        ROUND_STATUS.FAILED,
      ]),
    );
  });

  it("exposes every field required by useVaultDataReview on each vault", () => {
    for (const vault of MOCK_VAULTS) {
      for (const { key, type } of REQUIRED_FIELDS) {
        expect(typeof vault[key], `${vault.name}.${key}`).toBe(type);
      }
    }
  });

  it("uses only known ROUND_STATUS values and resolvable status meta", () => {
    const known = new Set(Object.values(ROUND_STATUS));
    for (const vault of MOCK_VAULTS) {
      expect(known.has(vault.status), vault.name).toBe(true);
      // Every status must render through the badge meta (no silent fallback drift).
      expect(getRoundStatusMeta(vault.status).label).not.toBe(
        getRoundStatusMeta(ROUND_STATUS.PENDING).label,
      );
    }
  });

  it("keeps vault identifiers unique", () => {
    const ids = MOCK_VAULTS.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps TVL and totalDeposits consistent for non-failed vaults", () => {
    for (const vault of MOCK_VAULTS) {
      if (vault.status === ROUND_STATUS.FAILED) continue;
      expect(vault.totalDeposits).toBeCloseTo(vault.tvl, 0);
    }
  });
});

describe("VAULT_ROUND_ARCHIVE", () => {
  it("links every archived round to an existing vault", () => {
    const vaultIds = new Set(MOCK_VAULTS.map((v) => v.id));
    for (const round of VAULT_ROUND_ARCHIVE) {
      expect(vaultIds.has(round.vaultId), round.vaultName).toBe(true);
    }
  });

  it("is coherent: yield never exceeds deposits and win counts are non-negative", () => {
    for (const round of VAULT_ROUND_ARCHIVE) {
      expect(round.yieldGenerated).toBeLessThanOrEqual(round.totalDeposits);
      expect(round.prizePayout).toBeGreaterThanOrEqual(0);
      expect(round.winnerCount).toBeGreaterThanOrEqual(0);
      expect(round.participants).toBeGreaterThanOrEqual(round.winnerCount);
    }
  });

  it("exposes a stable superset of archive fields used by the archive page", () => {
    const required = [
      "id",
      "vaultId",
      "vaultName",
      "asset",
      "network",
      "startDate",
      "endDate",
      "participants",
      "totalDeposits",
      "yieldGenerated",
      "prizePayout",
      "winnerCount",
    ];
    for (const round of VAULT_ROUND_ARCHIVE) {
      for (const field of required) {
        expect(round, round.id).toHaveProperty(field);
      }
    }
  });
});
