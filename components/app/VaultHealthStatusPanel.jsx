"use client";

import React, { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  HelpCircle,
  XCircle,
  Clock,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Server,
  Database,
  Shield,
} from "lucide-react";
import { getStatusBadgeStyles } from "@/lib/status-badge-styles";
import { fetchVaultHealth, REFRESH_INTERVAL_MS } from "@/lib/vault-health";

/**
 * Aggregated vault health panel (#115).
 *
 * Every status comes from `/api/health/vault`, which aggregates real backend
 * signals. This component used to pick each service state with
 * Math.random(), so "Healthy" was a coin flip; when a signal cannot be trusted
 * the row now reports Unknown instead of falling back to green.
 */

const SERVICE_ICONS = {
  "vault-contracts": Shield,
  "prize-oracle": Database,
  "data-indexer": Server,
};

const STATUS_CONFIG = {
  operational: { icon: CheckCircle, label: "Healthy" },
  degraded: { icon: AlertTriangle, label: "Degraded" },
  outage: { icon: XCircle, label: "Outage" },
  unknown: { icon: HelpCircle, label: "Unknown" },
};

const OVERALL_HEADLINE = {
  operational: "All vault services operational",
  degraded: "Some services are experiencing issues",
  outage: "Service outage detected",
  unknown: "Service status unknown",
};

function formatAge(ageMs) {
  if (typeof ageMs !== "number" || !Number.isFinite(ageMs)) return null;
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return seconds + "s ago";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
  return Math.floor(seconds / 3600) + "h ago";
}

function ServiceRow({ service, status, latencyMs, ageMs, stale, message }) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.unknown;
  const badgeStyles = getStatusBadgeStyles(status);
  const Icon = SERVICE_ICONS[service.id] || Activity;
  const StatusIcon = config.icon;
  const age = formatAge(ageMs);

  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-vault-border/50 bg-vault-surface/30 p-3">
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 h-4 w-4 text-vault-muted" aria-hidden="true" />
        <div>
          <span className="text-sm font-medium text-vault-text">{service.name}</span>
          {(message || age) && (
            <p className="mt-0.5 text-xs text-vault-muted">
              {message ? message : (stale ? "Showing a stale reading, " : "Updated ") + age}
            </p>
          )}
          {typeof latencyMs === "number" && (
            <p className="mt-0.5 text-xs text-vault-muted">
              {"Latency " + latencyMs + "ms"}
            </p>
          )}
        </div>
      </div>
      <span
        className={
          "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium " +
          badgeStyles.badge
        }
      >
        <StatusIcon className="h-3.5 w-3.5" aria-hidden="true" />
        {config.label}
      </span>
    </div>
  );
}

export default function VaultHealthStatusPanel() {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);

  const checkHealth = useCallback(async () => {
    setLoading(true);
    const result = await fetchVaultHealth();
    setHealth(result);
    setLastUpdated(new Date());
    setLoading(false);
  }, []);

  useEffect(() => {
    checkHealth();
    const interval = setInterval(checkHealth, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [checkHealth]);

  const overallStatus = health ? health.overall : "unknown";
  const statusConfig = STATUS_CONFIG[overallStatus] || STATUS_CONFIG.unknown;
  const StatusIcon = statusConfig.icon;
  const statusBadgeStyles = getStatusBadgeStyles(overallStatus);
  const headline =
    loading && !health
      ? "Checking service health..."
      : OVERALL_HEADLINE[overallStatus] || OVERALL_HEADLINE.unknown;

  const formatTime = (date) => {
    if (!date) return null;
    const diff = Math.floor((new Date() - date) / 1000);
    if (diff < 60) return "Just now";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    return date.toLocaleTimeString();
  };

  const updatedLabel = formatTime(lastUpdated);

  return (
    <section aria-label="Vault health status" className="vq-glass-hover overflow-hidden">
      <div className="p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span
              className={
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-full " +
                statusBadgeStyles.iconAvatar
              }
            >
              {loading ? (
                <RefreshCw className="h-5 w-5 animate-spin" aria-hidden="true" />
              ) : (
                <StatusIcon className="h-5 w-5" aria-hidden="true" />
              )}
            </span>
            <div>
              <h3 className="text-sm font-semibold text-vault-text">
                Vault Network Status
              </h3>
              <p className="text-xs text-vault-muted">{headline}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={checkHealth}
              disabled={loading}
              className="vq-btn-ghost h-8 px-2.5 disabled:opacity-60"
              aria-label="Refresh status"
            >
              <RefreshCw
                className={"h-4 w-4 " + (loading ? "animate-spin" : "")}
                aria-hidden="true"
              />
            </button>
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="vq-btn-ghost h-8 px-2.5"
              aria-expanded={expanded}
              aria-label={expanded ? "Collapse details" : "Expand details"}
            >
              {expanded ? (
                <ChevronUp className="h-4 w-4" aria-hidden="true" />
              ) : (
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>

        {updatedLabel && (
          <div className="mt-3 flex items-center gap-1.5 text-xs text-vault-muted">
            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
            Last updated: {updatedLabel}
          </div>
        )}

        {health && health.reason && (
          <div
            role="alert"
            className={
              "mt-3 flex items-start gap-2 rounded-lg border p-3 text-sm " +
              statusBadgeStyles.banner
            }
          >
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span>{health.reason}</span>
          </div>
        )}
      </div>

      <AnimatePresence>
        {expanded && health && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden border-t border-vault-border/30"
          >
            <div className="space-y-2 p-5 sm:p-6 pt-0">
              {health.services.length === 0 && (
                <p className="text-sm text-vault-muted text-center py-4">
                  No services to display.
                </p>
              )}
              {health.services.map((svc) => (
                <ServiceRow
                  key={svc.id}
                  service={svc}
                  status={svc.status}
                  latencyMs={svc.latencyMs}
                  ageMs={svc.ageMs}
                  stale={svc.stale}
                  message={svc.message}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
