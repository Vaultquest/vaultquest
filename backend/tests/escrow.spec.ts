import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";
import {
  EscrowService,
  type HorizonGateway,
  type AdminSigner,
  type TransactionAssembler,
  type SubmitResult
} from "../src/services/escrowService.js";
import { SavingsService } from "../src/services/savingsService.js";

const PASSPHRASE = "Test SDF Network ; September 2015";

function makeSigner(): AdminSigner {
  return {
    publicKey: "GADMIN0000000000000000000000000000000000000000000000000",
    async sign(xdr) {
      return `signed:${xdr}`;
    }
  };
}

const assembler: TransactionAssembler = {
  async assemble(input) {
    return {
      xdr: `xdr:${input.vaultId}:${input.sequence}`,
      sourceAccount: "GADMIN",
      sequence: input.sequence
    };
  }
};

/** Horizon stub whose submit results are scripted per call. */
function scriptedHorizon(results: SubmitResult[]): HorizonGateway & { seqLoads: number; submits: string[] } {
  let seq = 100;
  const submits: string[] = [];
  let i = 0;
  return {
    seqLoads: 0,
    submits,
    async loadSequence() {
      this.seqLoads += 1;
      return String(seq++);
    },
    async submit(signedXdr) {
      submits.push(signedXdr);
      const r = results[Math.min(i, results.length - 1)] as SubmitResult;
      i += 1;
      return r;
    }
  };
}

describe("EscrowService settlement pipeline", () => {
  let db: TestDb;
  beforeAll(async () => { db = await startTestDb(); });
  afterAll(async () => { await db.stop(); });
  beforeEach(async () => {
    await resetDb(db.prisma);
    await db.prisma.vaultSettlement.deleteMany({});
  });

  it("prepares, signs and submits a successful release, saving the tx hash", async () => {
    const horizon = scriptedHorizon([{ hash: "tx_abc", successful: true, resultCode: "tx_success" }]);
    const svc = new EscrowService({
      prisma: db.prisma, horizon, signer: makeSigner(), assembler,
      networkPassphrase: PASSPHRASE, sleep: async () => {}
    });

    const outcome = await svc.settleVault({ vaultId: "v1", settlementType: "release", recipient: "GWIN", amount: "100" });

    expect(outcome.state).toBe("Resolved");
    expect(outcome.txHash).toBe("tx_abc");
    expect(horizon.submits[0]).toContain("signed:xdr:v1");

    const row = await db.prisma.vaultSettlement.findUnique({ where: { vaultId: "v1" } });
    expect(row?.txHash).toBe("tx_abc");
    expect(row?.state).toBe("Resolved");
  });

  it("is idempotent: a resolved vault is not resubmitted", async () => {
    const horizon = scriptedHorizon([{ hash: "tx_once", successful: true, resultCode: "tx_success" }]);
    const svc = new EscrowService({
      prisma: db.prisma, horizon, signer: makeSigner(), assembler,
      networkPassphrase: PASSPHRASE, sleep: async () => {}
    });

    await svc.settleVault({ vaultId: "v2", settlementType: "release", recipient: "GWIN", amount: "100" });
    const second = await svc.settleVault({ vaultId: "v2", settlementType: "release", recipient: "GWIN", amount: "100" });

    expect(second.alreadySettled).toBe(true);
    expect(second.txHash).toBe("tx_once");
    expect(horizon.submits).toHaveLength(1); // not resubmitted
  });

  it("retries on a transient tx_bad_seq, reloading the sequence each time", async () => {
    const horizon = scriptedHorizon([
      { hash: "", successful: false, resultCode: "tx_bad_seq" },
      { hash: "", successful: false, resultCode: "tx_bad_seq" },
      { hash: "tx_ok", successful: true, resultCode: "tx_success" }
    ]);
    const svc = new EscrowService({
      prisma: db.prisma, horizon, signer: makeSigner(), assembler,
      networkPassphrase: PASSPHRASE, sleep: async () => {}
    });

    const outcome = await svc.settleVault({ vaultId: "v3", settlementType: "distribute", amount: "100" });

    expect(outcome.state).toBe("Resolved");
    expect(outcome.txHash).toBe("tx_ok");
    expect(outcome.attempts).toBe(3);
    expect(horizon.seqLoads).toBe(3); // sequence reloaded per attempt
  });

  it("rolls back to Unresolved when submission ultimately fails", async () => {
    const horizon = scriptedHorizon([{ hash: "", successful: false, resultCode: "tx_bad_seq" }]);
    const svc = new EscrowService({
      prisma: db.prisma, horizon, signer: makeSigner(), assembler,
      networkPassphrase: PASSPHRASE, sleep: async () => {}
    });

    const outcome = await svc.settleVault({ vaultId: "v4", settlementType: "release", recipient: "GWIN", amount: "100" });

    expect(outcome.state).toBe("Unresolved");
    expect(outcome.txHash).toBeNull();

    const row = await db.prisma.vaultSettlement.findUnique({ where: { vaultId: "v4" } });
    expect(row?.state).toBe("Unresolved");
    expect(row?.errorCode).toBe("SETTLEMENT_RETRIES_EXHAUSTED");
  });

  it("does not retry a non-retryable failure", async () => {
    const horizon = scriptedHorizon([{ hash: "", successful: false, resultCode: "tx_insufficient_balance" }]);
    const svc = new EscrowService({
      prisma: db.prisma, horizon, signer: makeSigner(), assembler,
      networkPassphrase: PASSPHRASE, sleep: async () => {}
    });

    const outcome = await svc.settleVault({ vaultId: "v5", settlementType: "release", recipient: "GWIN", amount: "100" });

    expect(outcome.state).toBe("Unresolved");
    expect(outcome.attempts).toBe(1);
    expect(horizon.submits).toHaveLength(1);
  });

  it("SavingsService settles a concluded period across vaults", async () => {
    const horizon = scriptedHorizon([{ hash: "h", successful: true, resultCode: "tx_success" }]);
    const escrow = new EscrowService({
      prisma: db.prisma, horizon, signer: makeSigner(), assembler,
      networkPassphrase: PASSPHRASE, sleep: async () => {}
    });
    const savings = new SavingsService(escrow);

    const result = await savings.settleConcludedPeriod([
      { vaultId: "p1", settlementType: "release", recipient: "GA", amount: "10" },
      { vaultId: "p2", settlementType: "refund", recipient: "GB", amount: "5" }
    ]);

    expect(result.total).toBe(2);
    expect(result.resolved).toBe(1);
    expect(result.refunded).toBe(1);
  });

  it("captures logs during successful and failed settlements", async () => {
    const loggedInfo: any[] = [];
    const loggedWarn: any[] = [];
    const loggedError: any[] = [];
    const logger = {
      info: (obj: any, msg?: string) => loggedInfo.push({ obj, msg }),
      warn: (obj: any, msg?: string) => loggedWarn.push({ obj, msg }),
      error: (obj: any, msg?: string) => loggedError.push({ obj, msg })
    };

    const horizon = scriptedHorizon([
      { hash: "", successful: false, resultCode: "tx_bad_seq" },
      { hash: "tx_ok", successful: true, resultCode: "tx_success" }
    ]);
    const svc = new EscrowService({
      prisma: db.prisma, horizon, signer: makeSigner(), assembler,
      networkPassphrase: PASSPHRASE, sleep: async () => {}, logger
    });

    await svc.settleVault({ vaultId: "v_log_test", settlementType: "release", recipient: "GWIN", amount: "100" });

    // Assert info logs exist for start and success
    expect(loggedInfo.length).toBeGreaterThan(0);
    expect(loggedInfo[0].msg).toBe("Starting vault settlement process");
    expect(loggedInfo.some(l => l.msg === "Horizon submission successful")).toBe(true);

    // Assert warn logs exist for transient failure
    expect(loggedWarn.length).toBe(1);
    expect(loggedWarn[0].obj.resultCode).toBe("tx_bad_seq");
    expect(loggedWarn[0].obj.isRetryable).toBe(true);
  });

  it("distinguishes retryable vs permanent failures and logged error", async () => {
    const loggedError: any[] = [];
    const logger = {
      info: () => {},
      warn: () => {},
      error: (obj: any, msg?: string) => loggedError.push({ obj, msg })
    };

    const horizon = scriptedHorizon([{ hash: "", successful: false, resultCode: "tx_bad_auth" }]);
    const svc = new EscrowService({
      prisma: db.prisma, horizon, signer: makeSigner(), assembler,
      networkPassphrase: PASSPHRASE, sleep: async () => {}, logger
    });

    const outcome = await svc.settleVault({ vaultId: "v_perm_fail", settlementType: "release", recipient: "GWIN", amount: "100" });

    expect(outcome.state).toBe("Unresolved");
    expect(outcome.attempts).toBe(1); // stops immediately because tx_bad_auth is not retryable
    expect(loggedError.length).toBe(1);
    expect(loggedError[0].msg).toBe("Vault settlement pipeline finished in unresolved state");
    expect(loggedError[0].obj.lastResultCode).toBe("tx_bad_auth");
  });

  it("subsequent duplicate settlement requests are idempotent and return identical cached results", async () => {
    const horizon = scriptedHorizon([{ hash: "tx_cache", successful: true, resultCode: "tx_success" }]);
    const svc = new EscrowService({
      prisma: db.prisma, horizon, signer: makeSigner(), assembler,
      networkPassphrase: PASSPHRASE, sleep: async () => {}
    });

    const outcome1 = await svc.settleVault({ vaultId: "v_dup", settlementType: "release", recipient: "GWIN", amount: "100" });
    const outcome2 = await svc.settleVault({ vaultId: "v_dup", settlementType: "release", recipient: "GWIN", amount: "100" });

    expect(outcome1.state).toBe("Resolved");
    expect(outcome1.txHash).toBe("tx_cache");

    expect(outcome2.state).toBe("Resolved");
    expect(outcome2.txHash).toBe("tx_cache");
    expect(outcome2.attempts).toBe(0);
    expect(outcome2.alreadySettled).toBe(true);

    expect(horizon.submits).toHaveLength(1); // submitted exactly once
  });
});
