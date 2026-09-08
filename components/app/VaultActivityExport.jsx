"use client";

import { useState, useMemo } from "react";
import {
  Download,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ShieldCheck,
  FileSpreadsheet,
  FileCode,
} from "lucide-react";
import { generateActivityExport } from "@/lib/activity-export";

/**
 * VaultActivityExport — Client-side deterministic export component with tamper evidence and privacy redaction.
 *
 * Generates verified CSV or JSON files with an embedded SHA-256 checksum and provenance metadata.
 *
 * @param {object} props - Component props
 * @param {Array<Record<string, unknown>>} [props.activities=[]] - Array of activity records
 * @param {string} [props.filename="vault-activity"] - Base filename without extension
 * @param {string|null} [props.walletAddress=null] - Scoped wallet address for provenance metadata
 * @param {string} [props.network="testnet"] - Network scope
 * @param {boolean} [props.walletConnected=false] - Connection status flag
 * @param {{ deposits: number, withdrawals: number, rewards: number }|null} [props.summary=null] - Activity summary statistics
 * @returns {import("react").JSX.Element} Export activity control panel
 */
export default function VaultActivityExport({
  activities = [],
  filename = "vault-activity",
  walletAddress = null,
  network = "testnet",
  walletConnected = false,
  summary = null,
}) {
  const [format, setFormat] = useState("csv");
  const [redactSensitive, setRedactSensitive] = useState(true);
  const [status, setStatus] = useState("idle");
  const [lastExportChecksum, setLastExportChecksum] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  const exportPackage = useMemo(() => {
    if (!activities || activities.length === 0) {
      return null;
    }
    return generateActivityExport({
      activities,
      walletAddress,
      network,
      redactSensitive,
    });
  }, [activities, walletAddress, network, redactSensitive]);

  const handleExport = () => {
    if (!activities || activities.length === 0) {
      setStatus("error");
      setErrorMsg("No activity records to export.");
      return;
    }

    setStatus("loading");
    try {
      const pkg =
        exportPackage ||
        generateActivityExport({
          activities,
          walletAddress,
          network,
          redactSensitive,
        });

      const content = format === "csv" ? pkg.csvString : pkg.jsonString;
      const mime = format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8";
      const fullFilename = `${filename}.${format}`;

      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fullFilename;
      anchor.click();
      URL.revokeObjectURL(url);

      setLastExportChecksum(pkg.metadata.checksum);
      setStatus("success");
    } catch {
      setStatus("error");
      setErrorMsg("Export failed. Please try again.");
    }
  };

  const truncatedChecksum = exportPackage
    ? `${exportPackage.metadata.checksum.slice(0, 8)}…${exportPackage.metadata.checksum.slice(-8)}`
    : null;

  return (
    <div className="rounded-2xl border border-vault-border bg-vault-surface/60 p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-vault-text">Export activity</h3>
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-400">
              <ShieldCheck className="h-3 w-3" aria-hidden="true" />
              Tamper-Evident SHA-256
            </span>
          </div>
          <p className="mt-1 text-xs text-vault-muted">
            Download deterministic activity records with cryptographic provenance metadata and privacy redaction.
          </p>
        </div>

        {exportPackage && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span
              className="rounded-lg border border-vault-border bg-vault-bg px-2.5 py-1 font-mono text-vault-muted"
              title={`Full Checksum: ${exportPackage.metadata.checksum}`}
            >
              SHA-256: <span className="text-vault-text font-semibold">{truncatedChecksum}</span>
            </span>
            <span className="rounded-lg border border-vault-border bg-vault-bg px-2.5 py-1 text-vault-muted">
              Scope:{" "}
              <span className="text-vault-text font-medium">
                {walletAddress ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}` : "Unscoped"} ({network})
              </span>
            </span>
          </div>
        )}
      </div>

      {summary && (
        <div className="mt-3 flex items-center gap-4 text-xs text-vault-muted">
          <span>Deposits: <strong className="text-vault-text">{summary.deposits ?? 0}</strong></span>
          <span>Withdrawals: <strong className="text-vault-text">{summary.withdrawals ?? 0}</strong></span>
          <span>Rewards: <strong className="text-vault-text">{summary.rewards ?? 0}</strong></span>
          <span>Total records: <strong className="text-vault-text">{activities.length}</strong></span>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t border-vault-border/50 pt-4">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <label htmlFor="vae-format" className="text-xs font-medium text-vault-muted">
              Format:
            </label>
            <div className="inline-flex rounded-lg border border-vault-border bg-vault-bg p-0.5">
              <button
                type="button"
                onClick={() => {
                  setFormat("csv");
                  setStatus("idle");
                }}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  format === "csv"
                    ? "bg-vault-surface text-vault-text shadow-sm"
                    : "text-vault-muted hover:text-vault-text"
                }`}
                aria-pressed={format === "csv"}
              >
                <FileSpreadsheet className="h-3.5 w-3.5" aria-hidden="true" />
                CSV
              </button>
              <button
                type="button"
                onClick={() => {
                  setFormat("json");
                  setStatus("idle");
                }}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  format === "json"
                    ? "bg-vault-surface text-vault-text shadow-sm"
                    : "text-vault-muted hover:text-vault-text"
                }`}
                aria-pressed={format === "json"}
              >
                <FileCode className="h-3.5 w-3.5" aria-hidden="true" />
                JSON
              </button>
            </div>
          </div>

          <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-vault-muted select-none">
            <input
              type="checkbox"
              id="vae-redact-checkbox"
              checked={redactSensitive}
              onChange={(e) => {
                setRedactSensitive(e.target.checked);
                setStatus("idle");
              }}
              className="rounded border-vault-border bg-vault-bg text-vault-accent focus:ring-vault-accent"
            />
            <span>Redact sensitive memos & counterparty addresses</span>
          </label>
        </div>

        <button
          type="button"
          onClick={handleExport}
          disabled={status === "loading" || activities.length === 0}
          className="inline-flex items-center gap-2 rounded-xl bg-vault-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status === "loading" ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Download className="h-4 w-4" aria-hidden="true" />
          )}
          {status === "loading" ? "Exporting…" : `Export ${format.toUpperCase()}`}
        </button>
      </div>

      {status === "success" && (
        <div
          role="status"
          className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400"
        >
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              Downloaded <span className="font-mono font-semibold">{filename}.{format}</span> ({activities.length} records).
            </span>
          </div>
          {lastExportChecksum && (
            <span className="font-mono text-[11px] opacity-80" title="Cryptographic Checksum">
              Hash: {lastExportChecksum.slice(0, 10)}…{lastExportChecksum.slice(-10)}
            </span>
          )}
        </div>
      )}

      {status === "error" && (
        <div
          role="alert"
          className="mt-3 flex items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400"
        >
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{errorMsg}</span>
        </div>
      )}
    </div>
  );
}
