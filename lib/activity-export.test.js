import { describe, expect, it } from "vitest";
import {
  computeSha256,
  generateActivityExport,
  verifyActivityExportJson,
  verifyActivityExportCsv,
  redactRecord,
  sortRecordsDeterministically,
  formatCsvCell,
  CANONICAL_FIELDS,
} from "./activity-export";

const SAMPLE_ACTIVITIES = [
  {
    id: "tx-2",
    type: "reward",
    pool: "Community Drip Pool",
    asset: "USDC",
    amount: 42.5,
    date: "2026-05-20T09:00:00.000Z",
    status: "confirmed",
    walletAddress: "0x1111111111111111111111111111111111111111",
    counterparty: "0x2222222222222222222222222222222222222222",
    memo: "Private prize distribution note",
  },
  {
    id: "tx-1",
    type: "deposit",
    pool: "Community Drip Pool",
    asset: "USDC",
    amount: 500,
    date: "2026-05-28T14:22:00.000Z",
    status: "confirmed",
    walletAddress: "0x1111111111111111111111111111111111111111",
    counterparty: "GABCD1234567890STUVWXWXYZ1234567890ALPHABETA1234567890123456",
    apiKey: "vaultquest-secret-key-9999",
  },
  {
    id: "tx-3",
    type: "withdraw",
    pool: "Starter Vault",
    asset: "AVAX",
    amount: 100,
    date: "2026-05-10T11:30:00.000Z",
    status: "confirmed",
    walletAddress: "0x1111111111111111111111111111111111111111",
    privateMemo: "Internal audit flag",
    token: "Bearer secret-token-xyz",
  },
];

describe("lib/activity-export - Deterministic and Tamper-Evident Engine", () => {
  describe("Cryptographic SHA-256 Digest", () => {
    it("computes authentic standard 64-character hex hash", () => {
      const hash = computeSha256("vaultquest-tamper-evident-activity");
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
      expect(computeSha256("test")).toBe("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08");
    });
  });

  describe("Deterministic Sorting and Canonicalization", () => {
    it("orders records by date descending with secondary tie-break by id", () => {
      const unsorted = [
        { id: "tx-b", date: "2026-05-01T10:00:00.000Z", amount: 10 },
        { id: "tx-c", date: "2026-05-10T10:00:00.000Z", amount: 20 },
        { id: "tx-a", date: "2026-05-01T10:00:00.000Z", amount: 30 },
      ];

      const sorted = sortRecordsDeterministically(unsorted);
      expect(sorted.map((r) => r.id)).toEqual(["tx-c", "tx-a", "tx-b"]);
    });

    it("ensures byte-for-byte reproducibility across runs with identical inputs", () => {
      const fixedTimestamp = "2026-06-01T00:00:00.000Z";
      const exportA = generateActivityExport({
        activities: SAMPLE_ACTIVITIES,
        walletAddress: "0x1111111111111111111111111111111111111111",
        network: "testnet",
        generatedAt: fixedTimestamp,
      });

      const reversedInput = [...SAMPLE_ACTIVITIES].reverse();
      const exportB = generateActivityExport({
        activities: reversedInput,
        walletAddress: "0x1111111111111111111111111111111111111111",
        network: "testnet",
        generatedAt: fixedTimestamp,
      });

      expect(exportA.jsonString).toBe(exportB.jsonString);
      expect(exportA.csvString).toBe(exportB.csvString);
      expect(exportA.metadata.checksum).toBe(exportB.metadata.checksum);
    });
  });

  describe("Provenance Metadata Envelope", () => {
    it("includes schemaVersion, generatedAt, wallet and network scope, recordCount, and checksum", () => {
      const fixedTime = "2026-09-08T12:00:00.000Z";
      const exported = generateActivityExport({
        activities: SAMPLE_ACTIVITIES,
        walletAddress: "0x1111111111111111111111111111111111111111",
        network: "testnet",
        generatedAt: fixedTime,
      });

      expect(exported.metadata).toEqual({
        schemaVersion: "1.0.0",
        generatedAt: fixedTime,
        scope: {
          wallet: "0x1111111111111111111111111111111111111111",
          network: "testnet",
        },
        recordCount: 3,
        checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    });
  });

  describe("Privacy Redaction", () => {
    it("redacts sensitive fields such as memo, apiKey, notes, and token headers", () => {
      const raw = {
        id: "tx-sec",
        memo: "Top secret internal memo",
        privateMemo: "Do not disclose",
        apiKey: "sk_live_123456",
        internalNote: "flagged account",
        email: "user@example.com",
        phone: "+15555555555",
        ip: "192.168.1.1",
        token: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDcSemACt8x4iTMCda8Yhe3iZaWbvV5XKSTbuAn0M",
      };

      const redacted = redactRecord(raw, { redactSensitive: true });
      expect(redacted.memo).toBe("[REDACTED]");
      expect(redacted.privateMemo).toBe("[REDACTED]");
      expect(redacted.apiKey).toBe("[REDACTED]");
      expect(redacted.internalNote).toBe("[REDACTED]");
      expect(redacted.email).toBe("[REDACTED]");
      expect(redacted.phone).toBe("[REDACTED]");
      expect(redacted.ip).toBe("[REDACTED]");
      expect(redacted.token).toBe("[REDACTED]");
    });

    it("masks counterparty foreign addresses while preserving scoped wallet address", () => {
      const scopedWallet = "0x1111111111111111111111111111111111111111";
      const counterpartyStellar = "GABCD1234567890STUVWXWXYZ1234567890ALPHABETA1234567890123456";
      const foreignWallet = "0x9999999999999999999999999999999999999999";

      const record = {
        id: "tx-addr",
        walletAddress: scopedWallet,
        counterparty: counterpartyStellar,
      };

      const redacted = redactRecord(record, { walletAddress: scopedWallet, redactSensitive: true });
      expect(redacted.walletAddress).toBe(scopedWallet);
      expect(redacted.counterparty).toBe("GABC...[REDACTED]");

      const foreignRecord = {
        id: "tx-foreign",
        walletAddress: foreignWallet,
      };
      const redactedForeign = redactRecord(foreignRecord, { walletAddress: scopedWallet, redactSensitive: true });
      expect(redactedForeign.walletAddress).toBe("0x99...[REDACTED]");
    });

    it("masks secret patterns appearing as raw string values", () => {
      const record = {
        id: "tx-secret",
        memo: "test",
        customAuth: "Bearer my-secret-session-token",
        stellarSecret: "SBBD47FLA5XYZ1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567",
      };

      const redacted = redactRecord(record, { redactSensitive: true });
      expect(redacted.customAuth).toBe("[REDACTED_SECRET]");
      expect(redacted.stellarSecret).toBe("[REDACTED_SECRET]");
    });

    it("leaves records unredacted when redactSensitive is explicitly false", () => {
      const raw = {
        id: "tx-raw",
        memo: "Explicit raw memo",
        counterparty: "0x2222222222222222222222222222222222222222",
      };

      const unredacted = redactRecord(raw, { redactSensitive: false });
      expect(unredacted.memo).toBe("Explicit raw memo");
      expect(unredacted.counterparty).toBe("0x2222222222222222222222222222222222222222");
    });
  });

  describe("CSV Formula Injection Protection", () => {
    it("neutralizes leading =, +, -, @ characters to prevent spreadsheet exploits", () => {
      expect(formatCsvCell("=SUM(A1:A10)")).toBe("'=SUM(A1:A10)");
      expect(formatCsvCell("+cmd|' /C calc'!A0")).toBe("'+cmd|' /C calc'!A0");
      expect(formatCsvCell("-2+3+cmd|' /C calc'!A0")).toBe("'-2+3+cmd|' /C calc'!A0");
      expect(formatCsvCell("@SUM(1+1)")).toBe("'@SUM(1+1)");
    });

    it("escapes quotes and wraps strings containing commas or newlines", () => {
      expect(formatCsvCell('hello "world"')).toBe('"hello ""world"""');
      expect(formatCsvCell("hello, world")).toBe('"hello, world"');
      expect(formatCsvCell("hello\nworld")).toBe('"hello\nworld"');
    });
  });

  describe("Audit Tamper Evidence - JSON Verification", () => {
    it("verifies genuine untouched JSON export successfully", () => {
      const exported = generateActivityExport({
        activities: SAMPLE_ACTIVITIES,
        walletAddress: "0x1111111111111111111111111111111111111111",
        network: "testnet",
      });

      const result = verifyActivityExportJson(exported.jsonString);
      expect(result.valid).toBe(true);
      expect(result.tampered).toBe(false);
      expect(result.recordCount).toBe(3);
      expect(result.calculatedChecksum).toBe(exported.metadata.checksum);
    });

    it("detects tampering when an amount is modified", () => {
      const exported = generateActivityExport({
        activities: SAMPLE_ACTIVITIES,
        walletAddress: "0x1111111111111111111111111111111111111111",
      });

      const parsed = JSON.parse(exported.jsonString);
      parsed.records[0].amount = 999999;

      const result = verifyActivityExportJson(parsed);
      expect(result.valid).toBe(false);
      expect(result.tampered).toBe(true);
      expect(result.reason).toContain("checksum mismatch");
    });

    it("detects tampering when a transaction status is altered", () => {
      const exported = generateActivityExport({ activities: SAMPLE_ACTIVITIES });
      const parsed = JSON.parse(exported.jsonString);
      parsed.records[1].status = "failed";

      const result = verifyActivityExportJson(parsed);
      expect(result.valid).toBe(false);
      expect(result.tampered).toBe(true);
    });

    it("detects tampering when an unauthorized record is injected", () => {
      const exported = generateActivityExport({ activities: SAMPLE_ACTIVITIES });
      const parsed = JSON.parse(exported.jsonString);
      parsed.records.push({
        id: "tx-fake",
        type: "deposit",
        amount: 10000,
        date: "2026-06-01T00:00:00.000Z",
      });

      const result = verifyActivityExportJson(parsed);
      expect(result.valid).toBe(false);
      expect(result.tampered).toBe(true);
      expect(result.reason).toContain("Record count mismatch");
    });

    it("detects tampering when the metadata checksum is altered", () => {
      const exported = generateActivityExport({ activities: SAMPLE_ACTIVITIES });
      const parsed = JSON.parse(exported.jsonString);
      parsed.metadata.checksum = "0000000000000000000000000000000000000000000000000000000000000000";

      const result = verifyActivityExportJson(parsed);
      expect(result.valid).toBe(false);
      expect(result.tampered).toBe(true);
      expect(result.reason).toContain("checksum mismatch");
    });
  });

  describe("Audit Tamper Evidence - CSV Verification", () => {
    it("verifies genuine untouched CSV export with metadata comments", () => {
      const exported = generateActivityExport({
        activities: SAMPLE_ACTIVITIES,
        walletAddress: "0x1111111111111111111111111111111111111111",
        network: "testnet",
      });

      const result = verifyActivityExportCsv(exported.csvString);
      expect(result.valid).toBe(true);
      expect(result.tampered).toBe(false);
      expect(result.recordCount).toBe(3);
      expect(result.calculatedChecksum).toBe(exported.metadata.checksum);
    });

    it("detects tampering when a CSV line amount is modified", () => {
      const exported = generateActivityExport({ activities: SAMPLE_ACTIVITIES });
      const tamperedCsv = exported.csvString.replace("42.5", "99999.0");

      const result = verifyActivityExportCsv(tamperedCsv);
      expect(result.valid).toBe(false);
      expect(result.tampered).toBe(true);
      expect(result.reason).toContain("checksum mismatch");
    });

    it("detects tampering when a CSV metadata header comment is altered", () => {
      const exported = generateActivityExport({ activities: SAMPLE_ACTIVITIES });
      const tamperedCsv = exported.csvString.replace("# recordCount: 3", "# recordCount: 5");

      const result = verifyActivityExportCsv(tamperedCsv);
      expect(result.valid).toBe(false);
      expect(result.tampered).toBe(true);
      expect(result.reason).toContain("Record count mismatch");
    });
  });

  describe("Empty Activity Edge Case", () => {
    it("handles zero activity records with valid empty metadata envelope", () => {
      const exported = generateActivityExport({ activities: [] });
      expect(exported.metadata.recordCount).toBe(0);
      expect(exported.records).toEqual([]);

      const jsonResult = verifyActivityExportJson(exported.jsonString);
      expect(jsonResult.valid).toBe(true);

      const csvResult = verifyActivityExportCsv(exported.csvString);
      expect(csvResult.valid).toBe(true);
    });
  });
});
