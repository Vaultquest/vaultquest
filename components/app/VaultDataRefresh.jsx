"use client";

import React from "react";
import { AlertCircle, CheckCircle2, Clock, RefreshCw } from "lucide-react";
import { formatVaultDataAge } from "@/lib/vault-data-freshness";

const STATUS_LABELS = {
  loading: "Loading latest data",
  fresh: "Live data",
  stale: "Data is stale",
  degraded: "Partially degraded",
  unavailable: "Data unavailable",
};

export default function VaultDataRefresh({
  status,
  updatedAt,
  isRefreshing,
  error,
  onRefresh,
}) {
  const healthy = status === "fresh";
  const Icon = healthy ? CheckCircle2 : status === "unavailable" ? AlertCircle : Clock;

  return (
    <div className="relative vq-glass-hover flex items-center justify-between gap-4 p-4">
      <div className="flex items-center gap-3">
        <Icon
          size={16}
          className={healthy ? "text-emerald-500" : "text-amber-500"}
          aria-hidden="true"
        />
        <div>
          <p className="text-sm font-medium text-vault-text">{STATUS_LABELS[status]}</p>
          <p className="text-xs text-vault-muted">
            {formatVaultDataAge(updatedAt)}
            {updatedAt ? ` · ${updatedAt.toLocaleTimeString()}` : ""}
          </p>
        </div>
      </div>

      <button
        type="button"
        onClick={onRefresh}
        disabled={isRefreshing}
        className="vq-btn-ghost flex items-center gap-2 disabled:opacity-50"
      >
        <RefreshCw size={16} className={isRefreshing ? "animate-spin" : ""} aria-hidden="true" />
        {isRefreshing ? "Refreshing..." : "Refresh data"}
      </button>

      {error && (
        <p className="absolute left-0 right-0 top-full z-10 mt-2 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-500" role="alert">
          {error.message || "Unable to refresh vault data. Please try again."}
        </p>
      )}
    </div>
  );
}
