import { sha256 as viemSha256, stringToBytes } from "viem";

export const CANONICAL_FIELDS = [
  "id",
  "type",
  "pool",
  "asset",
  "amount",
  "date",
  "status",
  "txHash",
  "counterparty",
];

export const SENSITIVE_FIELD_KEYS = new Set([
  "memo",
  "privatememo",
  "note",
  "notes",
  "internalnote",
  "secret",
  "privatekey",
  "apikey",
  "token",
  "session",
  "auth",
  "authorization",
  "email",
  "phone",
  "ip",
  "ipaddress",
  "ssn",
  "password",
  "internalid",
  "stack",
  "stacktrace",
  "trace",
]);

const SECRET_VALUE_PATTERNS = [
  /^Bearer\s+[A-Za-z0-9._~+/-]+=*/i,
  /^eyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*$/,
  /^S[A-Za-z0-9]{55}$/,
  /^0x[a-fA-F0-9]{64}$/,
];

/**
 * Computes a SHA-256 hexadecimal digest for the given UTF-8 string.
 *
 * @param {string} text - UTF-8 text payload to hash
 * @returns {string} 64-character lowercase hexadecimal hash digest
 */
export function computeSha256(text) {
  const bytes = stringToBytes(String(text));
  return viemSha256(bytes).replace(/^0x/, "").toLowerCase();
}

/**
 * Formats a Stellar or EVM address with privacy masking.
 *
 * @param {string} address - Public wallet address string
 * @returns {string} Redacted address representation
 */
export function maskAddress(address) {
  if (!address || typeof address !== "string") {
    return "[REDACTED_ADDRESS]";
  }
  const clean = address.trim();
  if (clean.length <= 10) {
    return "[REDACTED_ADDRESS]";
  }
  return `${clean.slice(0, 4)}...[REDACTED]`;
}

/**
 * Applies privacy redaction to an individual activity record.
 *
 * @param {Record<string, unknown>} record - Raw activity record
 * @param {object} [options] - Redaction options
 * @param {string} [options.walletAddress] - Scoped authentic wallet address
 * @param {boolean} [options.redactSensitive=true] - Whether to redact sensitive attributes
 * @returns {Record<string, unknown>} Cleaned and redacted activity record
 */
export function redactRecord(record, options = {}) {
  const { walletAddress = null, redactSensitive = true } = options;
  if (!redactSensitive || !record || typeof record !== "object") {
    return { ...record };
  }

  const normalizedWallet = typeof walletAddress === "string" ? walletAddress.trim().toLowerCase() : null;
  const result = {};

  for (const [key, value] of Object.entries(record)) {
    const lowerKey = key.toLowerCase();

    if (SENSITIVE_FIELD_KEYS.has(lowerKey)) {
      result[key] = "[REDACTED]";
      continue;
    }

    if (
      lowerKey === "counterparty" ||
      lowerKey === "recipient" ||
      lowerKey === "fromaddress" ||
      lowerKey === "toaddress" ||
      lowerKey === "from_address" ||
      lowerKey === "to_address" ||
      lowerKey === "peeraddress"
    ) {
      result[key] = maskAddress(value);
      continue;
    }

    if (typeof value === "string") {
      const trimmed = value.trim();

      const matchesSecret = SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(trimmed));
      if (matchesSecret) {
        result[key] = "[REDACTED_SECRET]";
        continue;
      }

      if (
        (lowerKey === "walletaddress" || lowerKey === "wallet_address" || lowerKey === "account") &&
        normalizedWallet &&
        trimmed.toLowerCase() !== normalizedWallet
      ) {
        result[key] = maskAddress(trimmed);
        continue;
      }

      result[key] = trimmed;
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Normalizes an activity record into a deterministically sorted object.
 *
 * @param {Record<string, unknown>} record - Activity record to normalize
 * @returns {Record<string, unknown>} Record with alphabetical key order and normalized values
 */
export function canonicalizeRecord(record) {
  if (!record || typeof record !== "object") {
    return {};
  }

  const keys = Object.keys(record).sort();
  const canonical = {};

  for (const key of keys) {
    const value = record[key];
    if (value === undefined || value === null || value === "") {
      continue;
    }

    if (value instanceof Date) {
      canonical[key] = value.toISOString();
    } else if (key === "amount" && !Number.isNaN(Number(value))) {
      canonical[key] = Number(value);
    } else if (typeof value === "number" && !Number.isNaN(value)) {
      canonical[key] = value;
    } else if (typeof value === "object" && !Array.isArray(value)) {
      canonical[key] = canonicalizeRecord(value);
    } else {
      canonical[key] = value;
    }
  }

  return canonical;
}

/**
 * Compares two activity records to establish a deterministic total ordering.
 *
 * @param {Record<string, unknown>} a - First record
 * @param {Record<string, unknown>} b - Second record
 * @returns {number} Negative if a precedes b, positive if b precedes a, 0 if equal
 */
export function compareRecordsDeterministically(a, b) {
  const timeA = a.date ? Date.parse(a.date) : 0;
  const timeB = b.date ? Date.parse(b.date) : 0;

  if (!Number.isNaN(timeA) && !Number.isNaN(timeB) && timeA !== timeB) {
    return timeB - timeA;
  }

  const dateStrA = String(a.date ?? "");
  const dateStrB = String(b.date ?? "");
  if (dateStrA !== dateStrB) {
    return dateStrB.localeCompare(dateStrA);
  }

  const idA = String(a.id ?? "");
  const idB = String(b.id ?? "");
  if (idA !== idB) {
    return idA.localeCompare(idB);
  }

  return JSON.stringify(a).localeCompare(JSON.stringify(b));
}

/**
 * Produces a deterministically sorted array of canonicalized records.
 *
 * @param {Array<Record<string, unknown>>} records - Array of activity records
 * @returns {Array<Record<string, unknown>>} Sorted canonical records
 */
export function sortRecordsDeterministically(records) {
  if (!Array.isArray(records)) {
    return [];
  }
  return records
    .map((rec) => canonicalizeRecord(rec))
    .sort(compareRecordsDeterministically);
}

/**
 * Serializes an array of canonical records into a strict deterministic string for hashing.
 *
 * @param {Array<Record<string, unknown>>} records - Normalized and ordered records
 * @returns {string} Compact canonical JSON string
 */
export function serializeCanonicalRecords(records) {
  return JSON.stringify(records);
}

/**
 * Sanitizes a CSV cell to prevent formula injection in spreadsheet software.
 *
 * @param {unknown} value - Cell value
 * @returns {string} Escaped and neutralized cell string
 */
export function formatCsvCell(value) {
  if (value === null || value === undefined) {
    return "";
  }
  let str = String(value);

  if (/^[=+\-@]/.test(str)) {
    str = `'${str}`;
  }

  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Generates deterministic, tamper-evident, and privacy-redacted activity export artifacts.
 *
 * @param {object} params - Export configuration parameters
 * @param {Array<Record<string, unknown>>} [params.activities=[]] - Array of activity entries
 * @param {string|null} [params.walletAddress=null] - Scoped wallet address
 * @param {string} [params.network="testnet"] - Target network scope
 * @param {string} [params.schemaVersion="1.0.0"] - Envelope schema version
 * @param {boolean} [params.redactSensitive=true] - Enable privacy redaction
 * @param {string|null} [params.generatedAt=null] - Fixed ISO timestamp override for testing
 * @returns {{
 *   metadata: {
 *     schemaVersion: string,
 *     generatedAt: string,
 *     scope: { wallet: string, network: string },
 *     recordCount: number,
 *     checksum: string
 *   },
 *   records: Array<Record<string, unknown>>,
 *   jsonString: string,
 *   csvString: string
 * }} Deterministic export package
 */
export function generateActivityExport({
  activities = [],
  walletAddress = null,
  network = "testnet",
  schemaVersion = "1.0.0",
  redactSensitive = true,
  generatedAt = null,
} = {}) {
  const timestamp = generatedAt || new Date().toISOString();
  const scopedWallet = typeof walletAddress === "string" && walletAddress.trim() ? walletAddress.trim() : "unscoped";
  const scopedNetwork = typeof network === "string" && network.trim() ? network.trim() : "testnet";

  const sanitizedRecords = activities.map((entry) =>
    redactRecord(entry, { walletAddress: scopedWallet, redactSensitive })
  );

  const orderedRecords = sortRecordsDeterministically(sanitizedRecords);
  const canonicalPayload = serializeCanonicalRecords(orderedRecords);
  const checksum = computeSha256(canonicalPayload);

  const metadata = {
    schemaVersion,
    generatedAt: timestamp,
    scope: {
      wallet: scopedWallet,
      network: scopedNetwork,
    },
    recordCount: orderedRecords.length,
    checksum,
  };

  const jsonObject = {
    metadata,
    records: orderedRecords,
  };

  const jsonString = JSON.stringify(jsonObject, null, 2) + "\n";

  const allRecordKeys = new Set(CANONICAL_FIELDS);
  for (const rec of orderedRecords) {
    for (const k of Object.keys(rec)) {
      allRecordKeys.add(k);
    }
  }

  const extraKeys = Array.from(allRecordKeys)
    .filter((k) => !CANONICAL_FIELDS.includes(k))
    .sort();
  const orderedHeaders = [...CANONICAL_FIELDS, ...extraKeys];

  const metadataComments = [
    `# schemaVersion: ${metadata.schemaVersion}`,
    `# generatedAt: ${metadata.generatedAt}`,
    `# wallet: ${metadata.scope.wallet}`,
    `# network: ${metadata.scope.network}`,
    `# recordCount: ${metadata.recordCount}`,
    `# checksum: ${metadata.checksum}`,
  ];

  const headerRow = orderedHeaders.map(formatCsvCell).join(",");
  const dataRows = orderedRecords.map((record) =>
    orderedHeaders.map((field) => formatCsvCell(record[field])).join(",")
  );

  const csvString = [...metadataComments, headerRow, ...dataRows].join("\r\n") + "\r\n";

  return {
    metadata,
    records: orderedRecords,
    jsonString,
    csvString,
  };
}

/**
 * Validates a JSON activity export against its embedded checksum and metadata envelope.
 *
 * @param {string|object} jsonInput - Serialized JSON string or parsed JSON export payload
 * @returns {{
 *   valid: boolean,
 *   tampered: boolean,
 *   calculatedChecksum: string,
 *   expectedChecksum: string,
 *   recordCount: number,
 *   reason?: string
 * }} Audit validation result
 */
export function verifyActivityExportJson(jsonInput) {
  let parsed;
  try {
    parsed = typeof jsonInput === "string" ? JSON.parse(jsonInput) : jsonInput;
  } catch {
    return {
      valid: false,
      tampered: true,
      calculatedChecksum: "",
      expectedChecksum: "",
      recordCount: 0,
      reason: "Malformed JSON export payload",
    };
  }

  if (!parsed || typeof parsed !== "object" || !parsed.metadata || !Array.isArray(parsed.records)) {
    return {
      valid: false,
      tampered: true,
      calculatedChecksum: "",
      expectedChecksum: "",
      recordCount: 0,
      reason: "Missing required metadata or records array",
    };
  }

  const { metadata, records } = parsed;
  const expectedChecksum = String(metadata.checksum || "").trim().toLowerCase();

  if (metadata.recordCount !== records.length) {
    return {
      valid: false,
      tampered: true,
      calculatedChecksum: "",
      expectedChecksum,
      recordCount: records.length,
      reason: `Record count mismatch: metadata specifies ${metadata.recordCount}, found ${records.length}`,
    };
  }

  const orderedRecords = sortRecordsDeterministically(records);
  const canonicalPayload = serializeCanonicalRecords(orderedRecords);
  const calculatedChecksum = computeSha256(canonicalPayload);

  const valid = calculatedChecksum === expectedChecksum;

  return {
    valid,
    tampered: !valid,
    calculatedChecksum,
    expectedChecksum,
    recordCount: records.length,
    reason: valid ? undefined : "SHA-256 checksum mismatch: export content has been modified",
  };
}

/**
 * Parses raw CSV lines handling quoted cells with commas and escaped quotes.
 *
 * @param {string} line - Single CSV line
 * @returns {Array<string>} Array of unescaped cell strings
 */
function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

/**
 * Validates a CSV activity export against its embedded metadata comments and checksum.
 *
 * @param {string} csvInput - Raw CSV string with metadata comments
 * @returns {{
 *   valid: boolean,
 *   tampered: boolean,
 *   calculatedChecksum: string,
 *   expectedChecksum: string,
 *   recordCount: number,
 *   reason?: string
 * }} Audit validation result
 */
export function verifyActivityExportCsv(csvInput) {
  if (typeof csvInput !== "string" || !csvInput.trim()) {
    return {
      valid: false,
      tampered: true,
      calculatedChecksum: "",
      expectedChecksum: "",
      recordCount: 0,
      reason: "Empty or invalid CSV input",
    };
  }

  const lines = csvInput.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length > 0);
  const metadata = {};
  const dataLines = [];

  for (const line of lines) {
    if (line.startsWith("#")) {
      const match = line.slice(1).trim().match(/^([^:]+):\s*(.*)$/);
      if (match) {
        metadata[match[1].trim()] = match[2].trim();
      }
    } else {
      dataLines.push(line);
    }
  }

  const expectedChecksum = String(metadata.checksum || "").trim().toLowerCase();
  const expectedCount = metadata.recordCount !== undefined ? parseInt(metadata.recordCount, 10) : null;

  if (!expectedChecksum) {
    return {
      valid: false,
      tampered: true,
      calculatedChecksum: "",
      expectedChecksum: "",
      recordCount: 0,
      reason: "CSV missing # checksum metadata comment",
    };
  }

  if (dataLines.length === 0) {
    return {
      valid: false,
      tampered: true,
      calculatedChecksum: "",
      expectedChecksum,
      recordCount: 0,
      reason: "CSV missing header and data rows",
    };
  }

  const headerLine = dataLines[0];
  const headers = parseCsvLine(headerLine);
  const rowLines = dataLines.slice(1);

  if (expectedCount !== null && !Number.isNaN(expectedCount) && expectedCount !== rowLines.length) {
    return {
      valid: false,
      tampered: true,
      calculatedChecksum: "",
      expectedChecksum,
      recordCount: rowLines.length,
      reason: `Record count mismatch: metadata specifies ${expectedCount}, found ${rowLines.length}`,
    };
  }

  const records = rowLines.map((row) => {
    const values = parseCsvLine(row);
    const rec = {};
    headers.forEach((header, index) => {
      let val = values[index] ?? "";
      if (typeof val === "string" && val.startsWith("'") && /^[=+\-@]/.test(val.slice(1))) {
        val = val.slice(1);
      }
      if (val !== "") {
        rec[header] = val;
      }
    });
    return rec;
  });

  const orderedRecords = sortRecordsDeterministically(records);
  const canonicalPayload = serializeCanonicalRecords(orderedRecords);
  const calculatedChecksum = computeSha256(canonicalPayload);

  const valid = calculatedChecksum === expectedChecksum;

  return {
    valid,
    tampered: !valid,
    calculatedChecksum,
    expectedChecksum,
    recordCount: records.length,
    reason: valid ? undefined : "SHA-256 checksum mismatch: export content has been modified",
  };
}
