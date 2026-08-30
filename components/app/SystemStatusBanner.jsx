"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle,
  XCircle,
  ChevronDown,
  ChevronUp,
  RefreshCw,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { getStatusBadgeStyles } from "@/lib/status-badge-styles";

const STATUS_SEVERITY = {
  operational: { icon: CheckCircle, label: "Operational" },
  degraded: { icon: AlertTriangle, label: "Degraded" },
  outage: { icon: XCircle, label: "Outage" },
};

const PROBE_STATUSES = new Set(["operational", "degraded", "outage"]);
const PROBE_TIMEOUT_MS = 10000;

function normalizeStatus(status) {
  return PROBE_STATUSES.has(status) ? status : "outage";
}

function isValidProbe(data) {
  return (
    data &&
    typeof data === "object" &&
    typeof data.status === "string" &&
    Array.isArray(data.checks)
  );
}

function outageFrame(message) {
  return {
    aggregate: "outage",
    checkedAt: new Date(),
    checks: [
      {
        id: "backend",
        name: "VaultQuest Backend",
        url: "/api/health",
        status: "outage",
        latency: null,
        error: message,
      },
    ],
  };
}

function degradedFrame(message) {
  return {
    aggregate: "degraded",
    checkedAt: new Date(),
    checks: [
      {
        id: "backend",
        name: "VaultQuest Backend",
        url: "/api/health",
        status: "degraded",
        latency: null,
        error: message,
      },
    ],
  };
}

async function probeStatus() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const response = await fetch("/api/health", {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });

    // Defense-in-depth: a `mode: "no-cors"` opaque response (or any response
    // without a usable status) must never be treated as healthy — the whole
    // point of #116 is that an opaque response hides the real status.
    if (response.type === "opaque" || response.status === 0) {
      return outageFrame("Status probe returned an opaque response");
    }
    if (!response.ok) {
      return outageFrame(`Status probe failed (HTTP ${response.status})`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      return outageFrame("Status probe returned an invalid response");
    }
    if (!isValidProbe(payload)) {
      return outageFrame("Status probe returned an invalid payload");
    }

    const checks = payload.checks.map((check) => ({
      id: check.id ?? check.name ?? "unknown",
      name: check.name ?? "Unknown service",
      url: check.url ?? "",
      status: normalizeStatus(check.status),
      latency: typeof check.latency_ms === "number" ? check.latency_ms : null,
      error: typeof check.error === "string" ? check.error : null,
    }));

    return {
      aggregate: normalizeStatus(payload.status),
      checkedAt: payload.checked_at ? new Date(payload.checked_at) : new Date(),
      checks,
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      return degradedFrame("Status probe timed out");
    }
    return outageFrame(error?.message ?? "Status probe failed");
  } finally {
    clearTimeout(timeoutId);
  }
}

export default function SystemStatusBanner() {
  const [services, setServices] = useState([]);
  const [aggregate, setAggregate] = useState("operational");
  const [expanded, setExpanded] = useState(false);
  const [lastCheck, setLastCheck] = useState(null);
  const [checking, setChecking] = useState(false);

  const checkAllServices = useCallback(async () => {
    setChecking(true);
    try {
      const result = await probeStatus();
      setServices(result.checks);
      setAggregate(result.aggregate);
      setLastCheck(result.checkedAt);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    checkAllServices();
    const interval = setInterval(checkAllServices, 60000); // Check every minute
    return () => clearInterval(interval);
  }, [checkAllServices]);

  const hasIssues = aggregate !== "operational";
  const criticalIssues = services.filter((s) => s.status === "outage").length;
  const degradedIssues = services.filter((s) => s.status === "degraded").length;

  if (!hasIssues) return null;

  const severity = aggregate === "outage" ? "outage" : "degraded";
  const severityConfig = STATUS_SEVERITY[severity];
  const severityBadgeStyles = getStatusBadgeStyles(severity);

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={`vq-glass mb-6 ${severityBadgeStyles.banner}`}
    >
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${severityBadgeStyles.iconAvatar}`}
          >
            <severityConfig.icon className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="flex-1">
            <h2 className="text-sm font-semibold text-vault-text">
              {criticalIssues > 0
                ? `${criticalIssues} Service${criticalIssues > 1 ? "s" : ""} Down`
                : `${degradedIssues} Service${degradedIssues > 1 ? "s" : ""} Degraded`}
            </h2>
            <p className="mt-0.5 text-sm text-vault-muted">
              {criticalIssues > 0
                ? "Some blockchain nodes or APIs are experiencing outages. Transactions may fail."
                : "Network performance is degraded. You may experience slower response times."}
            </p>
            {lastCheck && (
              <p className="mt-1 text-xs text-vault-muted">
                Last checked: {lastCheck.toLocaleTimeString()}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={checkAllServices}
            disabled={checking}
            className="vq-btn-ghost h-9 px-3 disabled:opacity-60"
            aria-label="Refresh status"
          >
            <RefreshCw
              className={`h-4 w-4 ${checking ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="vq-btn-ghost h-9 px-3"
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse details" : "Expand details"}
          >
            {expanded ? (
              <ChevronUp className="h-4 w-4" aria-hidden="true" />
            ) : (
              <ChevronDown className="h-4 w-4" aria-hidden="true" />
            )}
            <span className="ml-1 text-xs">Details</span>
          </button>
        </div>
      </div>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden border-t border-vault-border"
          >
            <div className="space-y-2 p-4">
              {services.map((service) => {
                const statusConfig = STATUS_SEVERITY[service.status];
                const statusBadgeStyles = getStatusBadgeStyles(service.status);
                return (
                  <div
                    key={service.id}
                    className="flex items-center justify-between rounded-lg border border-vault-border bg-vault-surface/40 p-3"
                  >
                    <div className="flex items-center gap-3">
                      <statusConfig.icon
                        className={`h-4 w-4 ${statusBadgeStyles.solidIcon}`}
                        aria-hidden="true"
                      />
                      <div>
                        <p className="text-sm font-medium text-vault-text">
                          {service.name}
                        </p>
                        <p className="text-xs text-vault-muted">
                          {service.url}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${statusBadgeStyles.badge}`}
                      >
                        {statusConfig.label}
                      </span>
                      {(service.latency !== null || service.error) && (
                        <p className="mt-1 text-xs text-vault-muted">
                          {service.latency !== null
                            ? `${service.latency}ms`
                            : ""}
                          {service.latency !== null && service.error ? " — " : ""}
                          {service.error ?? ""}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}