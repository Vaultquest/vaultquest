/**
 * Eligibility snapshots for prize draws (#172).
 *
 * A round's winner must be reproducible by someone who was not in the room.
 * That needs three things this module provides: a schema, a canonical hash, and
 * a cutoff rule that is stated rather than implied.
 *
 * Cutoff rule (the part that decides disputes):
 *
 * - a deposit AT the cutoff timestamp is INCLUDED - the snapshot is taken at the
 *   close, so the close itself counts;
 * - a deposit after the cutoff is LATE and never enters the round, no matter when
 *   the snapshot is taken;
 * - a deposit that is not yet confirmed (pending, or failed) is EXCLUDED, because
 *   an unconfirmed transfer is not a balance;
 * - a timestamp that cannot be parsed is excluded rather than assumed, so a
 *   malformed row can never silently earn eligibility.
 *
 * The hash is over a canonical form: entries sorted by address, fixed field
 * order, addresses lowercased (Stellar public keys are case-insensitive), and
 * amounts as strings. Two callers that agree on the eligible set therefore agree
 * on the hash even if they built the object differently, which is what makes an
 * archived snapshot checkable after the fact.
 */

export const ELIGIBILITY_SNAPSHOT_VERSION = "eligibility-snapshot.v1";

/** Stroop precision: Stellar amounts carry at most 7 decimal places. */
const STROOP_DECIMALS = 7;

export type DepositStatus = "confirmed" | "pending" | "failed";

export interface EligibilityDepositInput {
  address: string;
  /** Decimal string, never a float. */
  amount: string;
  /** ISO timestamp of the deposit. */
  depositAt: string;
  status: DepositStatus;
}

export interface EligibilitySnapshotEntry {
  address: string;
  amount: string;
  depositAt: string;
}

export interface EligibilitySnapshot {
  schemaVersion: string;
  roundId: string;
  cutoffAt: string;
  entries: EligibilitySnapshotEntry[];
  entryCount: number;
  /** Sum of eligible amounts as a decimal string, computed in stroops. */
  totalAmount: string;
  /** "sha256:<hex>" over the canonical form. */
  hash: string;
}

export type EligibilityReason =
  | "eligible"
  | "late"
  | "unconfirmed"
  | "invalid_timestamp";

/**
 * Whether one deposit belongs to the round that closes at the cutoff.
 * Returns the reason as well as the verdict so a caller can explain an
 * exclusion instead of just dropping the row.
 */
export function evaluateDepositAtCutoff(input: {
  depositAt: string;
  cutoffAt: string;
  status: DepositStatus;
}): { eligible: boolean; reason: EligibilityReason } {
  if (input.status !== "confirmed") {
    return { eligible: false, reason: "unconfirmed" };
  }

  const deposited = Date.parse(input.depositAt);
  const cutoff = Date.parse(input.cutoffAt);
  if (!Number.isFinite(deposited) || !Number.isFinite(cutoff)) {
    return { eligible: false, reason: "invalid_timestamp" };
  }

  if (deposited > cutoff) {
    return { eligible: false, reason: "late" };
  }

  // deposited <= cutoff, including exactly at the cutoff.
  return { eligible: true, reason: "eligible" };
}

function normalizeAmount(amount: string): string | null {
  const trimmed = String(amount ?? "").trim();
  if (!/^[0-9]+(?:[.][0-9]{1,7})?$/.test(trimmed)) return null;
  const parts = trimmed.split(".");
  const whole = parts[0];
  const fraction = parts.length > 1 ? parts[1] : "";
  if (fraction === "") return whole;
  return whole + "." + fraction.padEnd(STROOP_DECIMALS, "0").slice(0, STROOP_DECIMALS);
}

function toStroops(amount: string): bigint {
  const parts = amount.split(".");
  const whole = parts[0];
  const fraction = parts.length > 1 ? parts[1] : "";
  const padded = fraction.padEnd(STROOP_DECIMALS, "0").slice(0, STROOP_DECIMALS);
  return BigInt(whole) * 10n ** BigInt(STROOP_DECIMALS) + BigInt(padded === "" ? "0" : padded);
}

function fromStroops(stroops: bigint): string {
  const unit = 10n ** BigInt(STROOP_DECIMALS);
  const whole = stroops / unit;
  const fraction = (stroops % unit).toString().padStart(STROOP_DECIMALS, "0");
  return whole.toString() + "." + fraction;
}

/**
 * Canonical string form. Deliberately not JSON.stringify of the caller object:
 * key order must not be able to change the hash.
 */
export function canonicalSnapshotPayload(input: {
  roundId: string;
  cutoffAt: string;
  entries: EligibilitySnapshotEntry[];
}): string {
  const sorted = [...input.entries].sort((a, b) =>
    a.address < b.address ? -1 : a.address > b.address ? 1 : 0,
  );
  const lines = sorted.map(
    (entry) => entry.address + "|" + entry.amount + "|" + entry.depositAt,
  );
  return [
    ELIGIBILITY_SNAPSHOT_VERSION,
    input.roundId,
    input.cutoffAt,
    ...lines,
  ].join(String.fromCharCode(10));
}

/** SHA-256 of the canonical payload, as "sha256:<hex>". */
export async function hashEligibilityPayload(payload: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "SHA-256 is unavailable in this environment, so an eligibility snapshot cannot be built.",
    );
  }
  const bytes = new TextEncoder().encode(payload);
  const digest = await subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return "sha256:" + hex;
}

/**
 * Build the snapshot for a round: filter by the cutoff rule, sort, total in
 * stroops, hash the canonical form.
 */
export async function buildEligibilitySnapshot(input: {
  roundId: string;
  cutoffAt: string;
  deposits: EligibilityDepositInput[];
}): Promise<{
  snapshot: EligibilitySnapshot;
  excluded: Array<{ address: string; reason: EligibilityReason }>;
}> {
  const excluded: Array<{ address: string; reason: EligibilityReason }> = [];
  const entries: EligibilitySnapshotEntry[] = [];

  for (const deposit of input.deposits) {
    const decision = evaluateDepositAtCutoff({
      depositAt: deposit.depositAt,
      cutoffAt: input.cutoffAt,
      status: deposit.status,
    });
    const amount = normalizeAmount(deposit.amount);

    if (!decision.eligible || amount === null) {
      excluded.push({
        address: String(deposit.address ?? "").toLowerCase(),
        reason: decision.eligible ? "unconfirmed" : decision.reason,
      });
      continue;
    }

    entries.push({
      address: String(deposit.address).toLowerCase(),
      amount,
      depositAt: new Date(Date.parse(deposit.depositAt)).toISOString(),
    });
  }

  entries.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));

  const payload = canonicalSnapshotPayload({
    roundId: input.roundId,
    cutoffAt: input.cutoffAt,
    entries,
  });
  const hash = await hashEligibilityPayload(payload);

  const totalStroops = entries.reduce((sum, entry) => sum + toStroops(entry.amount), 0n);

  return {
    excluded,
    snapshot: {
      schemaVersion: ELIGIBILITY_SNAPSHOT_VERSION,
      roundId: input.roundId,
      cutoffAt: input.cutoffAt,
      entries,
      entryCount: entries.length,
      totalAmount: fromStroops(totalStroops),
      hash,
    },
  };
}

/**
 * Recompute a snapshot hash from its own contents. An archived snapshot whose
 * hash no longer matches has been edited, and a draw proof that references it
 * should be treated as disputed rather than trusted.
 */
export async function verifySnapshotHash(snapshot: EligibilitySnapshot): Promise<boolean> {
  const payload = canonicalSnapshotPayload({
    roundId: snapshot.roundId,
    cutoffAt: snapshot.cutoffAt,
    entries: snapshot.entries,
  });
  return (await hashEligibilityPayload(payload)) === snapshot.hash;
}

/**
 * Compare two snapshots of the same round. A closed round must not gain entries,
 * so a non-empty "added" list is the signal that late deposits were folded in.
 */
export function diffEligibilitySnapshots(
  before: EligibilitySnapshot,
  after: EligibilitySnapshot,
): {
  added: string[];
  removed: string[];
  changed: Array<{ address: string; before: string; after: string }>;
} {
  const beforeMap = new Map(before.entries.map((entry) => [entry.address, entry]));
  const afterMap = new Map(after.entries.map((entry) => [entry.address, entry]));

  const added = [...afterMap.keys()].filter((address) => !beforeMap.has(address));
  const removed = [...beforeMap.keys()].filter((address) => !afterMap.has(address));

  const changed: Array<{ address: string; before: string; after: string }> = [];
  for (const [address, entry] of beforeMap) {
    const next = afterMap.get(address);
    if (next && next.amount !== entry.amount) {
      changed.push({ address, before: entry.amount, after: next.amount });
    }
  }

  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort((a, b) => (a.address < b.address ? -1 : 1)),
  };
}
