import { describe, it, expect } from "vitest";
import { toSafeCsvCell } from "../src/utils/csvEncoding.js";

/**
 * Formula-safe CSV encoding (issue #95).
 *
 * The vulnerability: `backend/src/routes/actions.ts` used to build CSV cells
 * with `` `"${String(v).replace(/"/g, '""')}"` `` -- doubling quotes and
 * wrapping in quotes, but never neutralizing a leading `=`, `+`, `-`, or `@`.
 * Since those cells are ultimately sourced from an attacker-controlled
 * `actionPayload`, a submitted action could smuggle a formula into an
 * operator's or user's spreadsheet.
 */

/** Extracts the raw cell content back out of `toSafeCsvCell`'s quoted output. */
function unquote(cell: string): string {
  return cell.slice(1, -1).replace(/""/g, '"');
}

describe("toSafeCsvCell", () => {
  describe("formula-prefix bypass matrix", () => {
    const directTriggers = [
      ["=", "=1+1"],
      ["+", "+1+1"],
      ["-", "-1+1"],
      ["@", "@SUM(1+1)"]
    ] as const;

    it.each(directTriggers)("guards a value starting directly with %s", (_char, payload) => {
      const cell = toSafeCsvCell(payload);
      // The guarded content must not itself start with a trigger character,
      // so no spreadsheet evaluates it as a formula.
      expect(unquote(cell).charAt(0)).toBe("'");
      expect(unquote(cell)).toBe(`'${payload}`);
    });

    it("guards the classic DDE/command-execution payload", () => {
      const payload = '=cmd|\' /C calc\'!A0';
      const cell = toSafeCsvCell(payload);
      expect(unquote(cell)).toBe(`'${payload}`);
    });

    const whitespaceBypasses = [
      ["leading tab", "\t=1+1"],
      ["leading space", " =1+1"],
      ["leading carriage return", "\r=1+1"],
      ["leading newline", "\n=1+1"],
      ["multiple mixed leading whitespace", " \t\r\n=1+1"]
    ] as const;

    it.each(whitespaceBypasses)(
      "still guards a formula hidden behind %s (naive first-char checks miss this)",
      (_label, payload) => {
        const cell = toSafeCsvCell(payload);
        const unquoted = unquote(cell);
        // The guard must land before the trigger character once whitespace
        // a spreadsheet would itself skip is stripped for detection.
        const normalized = unquoted.replace(/^[\s]+/, "");
        expect(normalized.charAt(0)).toBe("'");
      }
    );

    it("does not guard a value that merely contains a trigger character mid-string", () => {
      const payload = "vault=42";
      const cell = toSafeCsvCell(payload);
      expect(unquote(cell)).toBe(payload);
    });
  });

  describe("normal values round-trip correctly", () => {
    const normalValues: Array<[string, unknown, string]> = [
      ["a plain integer", 100, "100"],
      ["a decimal amount", "1234.56", "1234.56"],
      ["an ISO date", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
      ["a token symbol", "USDC", "USDC"],
      ["Unicode text", "café ✅ 日本語", "café ✅ 日本語"],
      ["an embedded comma delimiter", "USDC,XLM", "USDC,XLM"],
      ["an embedded newline", "line1\nline2", "line1\nline2"]
    ];

    it.each(normalValues)("%s is preserved exactly", (_label, input, expected) => {
      const cell = toSafeCsvCell(input);
      expect(unquote(cell)).toBe(expected);
    });

    it("doubles embedded double quotes per RFC 4180", () => {
      const cell = toSafeCsvCell('say "hi"');
      expect(cell).toBe('"say ""hi"""');
      expect(unquote(cell)).toBe('say "hi"');
    });

    it("always wraps the cell in double quotes, so delimiters are inert", () => {
      expect(toSafeCsvCell("USDC")).toBe('"USDC"');
    });

    it("renders null and undefined as an empty cell", () => {
      expect(toSafeCsvCell(null)).toBe('""');
      expect(toSafeCsvCell(undefined)).toBe('""');
    });
  });

  describe("negative/positive numbers (accepted trade-off)", () => {
    it("guards a legitimate negative amount, but preserves its string value", () => {
      // "-42.50" is indistinguishable, by content alone, from a formula that
      // starts with "-", so it is guarded like any other leading "-" value.
      // This is the documented, industry-standard trade-off of covering
      // "-"/"+" in the trigger set. The numeric string itself is untouched.
      const cell = toSafeCsvCell("-42.50");
      expect(unquote(cell)).toBe("'-42.50");
      expect(unquote(cell).slice(1)).toBe("-42.50");
    });
  });
});
