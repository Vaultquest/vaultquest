import { describe, it, expect } from "vitest";
import {
  buildEligibilitySnapshot,
  canonicalSnapshotPayload,
  diffEligibilitySnapshots,
  evaluateDepositAtCutoff,
  verifySnapshotHash,
  ELIGIBILITY_SNAPSHOT_VERSION,
  type EligibilityDepositInput,
  type EligibilitySnapshot,
} from "./eligibility-snapshot";

// #172: the cutoff rule and the hash are the two things a contributor needs to
// reproduce a draw, so both are pinned here.

const ROUND = "round-42";
const CUTOFF = "2026-09-13T00:00:00.000Z";
const WALLET_A = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const WALLET_B = "GCM333GLLQHMK2IW4UNJSDXIWPR3CU3LYVV26N7MUVKJZAHP7V6HT6PK";

function deposit(overrides: Partial<EligibilityDepositInput> = {}): EligibilityDepositInput {
  return {
    address: WALLET_A,
    amount: "100",
    depositAt: "2026-09-12T00:00:00.000Z",
    status: "confirmed",
    ...overrides,
  };
}

async function build(deposits: EligibilityDepositInput[], cutoffAt = CUTOFF) {
  return buildEligibilitySnapshot({ roundId: ROUND, cutoffAt, deposits });
}

describe("evaluateDepositAtCutoff", () => {
  it("includes a deposit made exactly at the cutoff", () => {
    expect(evaluateDepositAtCutoff({ depositAt: CUTOFF, cutoffAt: CUTOFF, status: "confirmed" })).toEqual({
      eligible: true,
      reason: "eligible",
    });
  });

  it("excludes a deposit made one millisecond after the cutoff", () => {
    expect(
      evaluateDepositAtCutoff({
        depositAt: "2026-09-13T00:00:00.001Z",
        cutoffAt: CUTOFF,
        status: "confirmed",
      }),
    ).toEqual({ eligible: false, reason: "late" });
  });

  it("excludes pending and failed deposits even before the cutoff", () => {
    for (const status of ["pending", "failed"] as const) {
      expect(
        evaluateDepositAtCutoff({ depositAt: "2026-09-01T00:00:00.000Z", cutoffAt: CUTOFF, status }),
      ).toEqual({ eligible: false, reason: "unconfirmed" });
    }
  });

  it("excludes an unparsable timestamp instead of assuming it is eligible", () => {
    expect(
      evaluateDepositAtCutoff({ depositAt: "not-a-date", cutoffAt: CUTOFF, status: "confirmed" }),
    ).toEqual({ eligible: false, reason: "invalid_timestamp" });
    expect(
      evaluateDepositAtCutoff({ depositAt: CUTOFF, cutoffAt: "nope", status: "confirmed" }),
    ).toEqual({ eligible: false, reason: "invalid_timestamp" });
  });
});

describe("buildEligibilitySnapshot", () => {
  it("keeps only eligible deposits and reports why the others were dropped", async () => {
    const { snapshot, excluded } = await build([
      deposit({ address: WALLET_A }),
      deposit({ address: WALLET_B, depositAt: "2026-09-13T00:00:01.000Z" }),
      deposit({ address: "G" + "D".repeat(55), status: "pending" }),
    ]);

    expect(snapshot.entryCount).toBe(1);
    expect(snapshot.entries[0].address).toBe(WALLET_A.toLowerCase());
    expect(excluded).toEqual([
      { address: WALLET_B.toLowerCase(), reason: "late" },
      { address: ("G" + "D".repeat(55)).toLowerCase(), reason: "unconfirmed" },
    ]);
  });

  it("emits a versioned schema and a prefixed digest", async () => {
    const { snapshot } = await build([deposit()]);
    expect(snapshot.schemaVersion).toBe(ELIGIBILITY_SNAPSHOT_VERSION);
    expect(snapshot.roundId).toBe(ROUND);
    expect(snapshot.cutoffAt).toBe(CUTOFF);
    expect(snapshot.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("totals amounts in stroops, so decimals do not drift", async () => {
    const { snapshot } = await build([
      deposit({ address: WALLET_A, amount: "0.1" }),
      deposit({ address: WALLET_B, amount: "0.2" }),
    ]);
    // 0.1 + 0.2 in floats would render as 0.30000000000000004.
    expect(snapshot.totalAmount).toBe("0.3000000");
  });

  it("normalizes amounts to stroop precision", async () => {
    const { snapshot } = await build([deposit({ amount: "42.5" })]);
    expect(snapshot.entries[0].amount).toBe("42.5000000");
  });

  it("sorts entries so the order of the input cannot change the hash", async () => {
    const first = await build([deposit({ address: WALLET_A }), deposit({ address: WALLET_B })]);
    const second = await build([deposit({ address: WALLET_B }), deposit({ address: WALLET_A })]);
    expect(second.snapshot.entries.map((e) => e.address)).toEqual(
      first.snapshot.entries.map((e) => e.address),
    );
    expect(second.snapshot.hash).toBe(first.snapshot.hash);
  });

  it("is deterministic across identical rebuilds", async () => {
    const a = await build([deposit()]);
    const b = await build([deposit()]);
    expect(a.snapshot.hash).toBe(b.snapshot.hash);
  });

  it("leaves a closed round untouched when a late deposit arrives", async () => {
    const closed = await build([deposit({ address: WALLET_A })]);
    const rebuilt = await build([
      deposit({ address: WALLET_A }),
      deposit({
        address: WALLET_B,
        depositAt: "2026-09-13T00:00:05.000Z",
      }),
    ]);

    expect(rebuilt.snapshot.hash).toBe(closed.snapshot.hash);
    expect(rebuilt.snapshot.entryCount).toBe(1);
    const diff = diffEligibilitySnapshots(closed.snapshot, rebuilt.snapshot);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it("detects a folded-in deposit when the snapshot is rebuilt with a different cutoff", async () => {
    const closed = await build([deposit({ address: WALLET_A })]);
    const extended = await build(
      [
        deposit({ address: WALLET_A }),
        deposit({ address: WALLET_B, depositAt: "2026-09-13T00:00:05.000Z" }),
      ],
      "2026-09-14T00:00:00.000Z",
    );

    expect(extended.snapshot.hash).not.toBe(closed.snapshot.hash);
    expect(diffEligibilitySnapshots(closed.snapshot, extended.snapshot).added).toEqual([
      WALLET_B.toLowerCase(),
    ]);
  });
});

describe("canonicalSnapshotPayload", () => {
  it("ignores the order of the entries it is handed", () => {
    const entries = [
      { address: WALLET_B.toLowerCase(), amount: "1.0000000", depositAt: CUTOFF },
      { address: WALLET_A.toLowerCase(), amount: "2.0000000", depositAt: CUTOFF },
    ];
    const forward = canonicalSnapshotPayload({ roundId: ROUND, cutoffAt: CUTOFF, entries });
    const reversed = canonicalSnapshotPayload({
      roundId: ROUND,
      cutoffAt: CUTOFF,
      entries: [...entries].reverse(),
    });
    expect(reversed).toBe(forward);
  });
});

describe("verifySnapshotHash", () => {
  it("accepts an untouched snapshot", async () => {
    const { snapshot } = await build([deposit()]);
    expect(await verifySnapshotHash(snapshot)).toBe(true);
  });

  it("rejects a snapshot whose amount was edited after the fact", async () => {
    const { snapshot } = await build([deposit({ amount: "100" })]);
    const tampered: EligibilitySnapshot = {
      ...snapshot,
      entries: [{ ...snapshot.entries[0], amount: "1000.0000000" }],
      totalAmount: "1000.0000000",
    };
    expect(await verifySnapshotHash(tampered)).toBe(false);
  });

  it("rejects a snapshot with an extra entry appended", async () => {
    const { snapshot } = await build([deposit({ address: WALLET_A })]);
    const tampered: EligibilitySnapshot = {
      ...snapshot,
      entries: [
        ...snapshot.entries,
        { address: WALLET_B.toLowerCase(), amount: "5.0000000", depositAt: CUTOFF },
      ],
    };
    expect(await verifySnapshotHash(tampered)).toBe(false);
  });
});
