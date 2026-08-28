/**
 * Formula-safe CSV cell encoding (issue #95).
 *
 * A CSV cell whose visible content starts with `=`, `+`, `-`, or `@` is
 * evaluated as a formula by Excel, Google Sheets, and LibreOffice Calc when
 * the file is opened. Every column this backend currently exports to CSV
 * (vault id, token, amount, ...) is ultimately sourced from an
 * attacker-controlled `actionPayload`, so a submitted action can smuggle a
 * formula into an operator's or user's spreadsheet the moment they open the
 * exported file. Doubling embedded quotes and wrapping the cell in quotes
 * (the previous behavior) makes the file valid CSV but does nothing to stop
 * the formula from executing.
 *
 * Mitigation follows OWASP's CSV Injection guidance
 * (https://owasp.org/www-community/attacks/CSV_Injection): prefix a
 * dangerous cell with a single quote before quoting it. Spreadsheet
 * applications treat a leading `'` as an explicit "this is text" marker and
 * stop evaluating the cell, so it renders as inert text instead of running
 * as a formula. Cells that don't start with a trigger character are left
 * byte-for-byte untouched.
 *
 * Known, accepted trade-off: this necessarily also guards legitimate values
 * that happen to start with `-` or `+` (e.g. a negative amount, "-42.50").
 * Once guarded, such a cell opens in Excel as *text* rather than as a native
 * number -- there is no way to tell "user's negative number" apart from
 * "attacker's formula" from the cell content alone, so every CSV-injection
 * defense that covers `-`/`+` has this same effect. The underlying string
 * value is still fully preserved: reading the cell back and dropping a
 * leading guard quote recovers the original value exactly.
 */

/** Leading characters that common spreadsheet tools evaluate as a formula. */
const FORMULA_TRIGGER_CHARS = new Set(["=", "+", "-", "@"]);

/** Prepended to a dangerous cell to force spreadsheet apps to treat it as literal text. */
const FORMULA_GUARD = "'";

/**
 * Leading control characters and whitespace that spreadsheet applications
 * skip over before deciding whether a cell is a formula. A naive check of
 * only the raw first character can be bypassed by hiding a trigger
 * character behind these (e.g. "\t=1+1", " =1+1"). `\p{Cc}` (the Unicode
 * "Control" category) covers the C0 and C1 control codes; the `u` flag is
 * required for `\p{...}` property escapes.
 */
const LEADING_NORMALIZATION_PATTERN = /^[\s\p{Cc}]+/u;

/**
 * True if `value`, after normalizing away any leading control/whitespace
 * characters, begins with a formula-trigger character.
 *
 * O(k) where k is the length of the leading whitespace/control run -- the
 * regex anchors at the start and does not scan the rest of the string.
 */
function startsWithFormulaTrigger(value: string): boolean {
  const normalized = value.replace(LEADING_NORMALIZATION_PATTERN, "");
  return FORMULA_TRIGGER_CHARS.has(normalized.charAt(0));
}

/**
 * Converts an arbitrary value into a single formula-safe, RFC 4180 CSV cell.
 *
 * - `null`/`undefined` become an empty cell, matching how callers already
 *   pass through optional fields (e.g. `r.txHash ?? ""`).
 * - Every cell is unconditionally wrapped in double quotes, so delimiters
 *   and embedded newlines are always safe -- unchanged from the encoder
 *   this replaces.
 * - Embedded double quotes are doubled.
 * - A value that would be read as a formula gets a leading single quote
 *   *before* quoting, so the entire cell -- including any characters after
 *   the trigger -- is treated as literal text by the spreadsheet.
 *
 * O(n) in the length of the stringified value: one pass to detect a leading
 * trigger, one pass to escape embedded quotes. O(n) space for the result.
 */
export function toSafeCsvCell(value: unknown): string {
  const raw = value == null ? "" : String(value);
  const guarded = startsWithFormulaTrigger(raw) ? FORMULA_GUARD + raw : raw;
  return `"${guarded.replace(/"/g, '""')}"`;
}
