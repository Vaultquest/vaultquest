"use client";

import { AlertTriangle } from "lucide-react";

/**
 * Displays data quality warnings produced by useVaultDataReview.
 * Renders nothing when there are no warnings.
 *
 * @param {{ warnings: string[] }} props
 */
export default function VaultDataWarnings({ warnings = [], status = "fresh" }) {
  if (!warnings.length && status === "fresh") return null;

  const unavailable = status === "unavailable";
  const heading =
    status === "loading"
      ? "Loading the latest vault data"
      : unavailable
        ? "Vault data is currently unavailable"
        : status === "stale"
          ? "Vault data may be out of date"
          : "Some vault data could not be loaded";

  return (
    <div
      role={unavailable ? "alert" : "status"}
      aria-live={unavailable ? "assertive" : "polite"}
      className={`flex gap-3 rounded-xl border p-4 ${
        unavailable
          ? "border-red-400/30 bg-red-500/10"
          : "border-amber-400/30 bg-amber-500/10"
      }`}
    >
      <AlertTriangle
        className="mt-0.5 h-4 w-4 shrink-0 text-amber-500"
        aria-hidden="true"
      />
      <div className="space-y-1">
        <p className="text-xs font-semibold text-vault-text">
          {heading}
        </p>
        <ul className="space-y-0.5">
          {(warnings.length > 0
            ? warnings
            : [
                unavailable
                  ? "Live totals and prize timing cannot be verified. Try refreshing before making a transaction."
                  : status === "loading"
                    ? "Vault totals will appear when the first response arrives."
                    : "Read-only browsing remains available while fresh data is requested.",
              ]
          ).map((w, i) => (
            <li key={i} className="text-xs text-vault-muted">
              {w}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
