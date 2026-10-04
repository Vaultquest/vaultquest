"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Gauge,
  RefreshCw,
  Server,
  Shield,
  Settings,
  SquareStack,
} from "lucide-react";
import { motion } from "framer-motion";
import { getStatusBadgeStyles } from "@/lib/status-badge-styles";

const PROTOCOL_PARAMETERS = [
  {
    label: "Round duration",
    value: "7 days",
    note: "New rounds auto-open on a weekly cadence.",
  },
  {
    label: "Minimum deposit",
    value: "100 XLM",
    note: "Keeps operational churn low for small deposits.",
  },
  {
    label: "Maximum deposit per vault",
    value: "250,000 XLM",
    note: "Prevents single-wallet concentration risk.",
  },
  {
    label: "Treasury fee",
    value: "0.75%",
    note: "Applied to routed yield before prize allocation.",
  },
  {
    label: "Settlement quorum",
    value: "3 of 5",
    note: "Requires multisig approval for admin writes.",
  },
  {
    label: "Emergency pause threshold",
    value: "2 failed attempts",
    note: "Triggers manual review before retrying settlement.",
  },
];

const ACTIVE_ROUNDS = [
  {
    name: "XLM Community Drip",
    status: "drawing",
    pool: "18.4M XLM",
    participants: "8,412 savers",
    deadline: "Draw closes in 31 minutes",
    progress: 92,
    nextAction: "Finalize winner selection and publish receipt.",
  },
  {
    name: "USDC Growth Vault",
    status: "open",
    pool: "4.2M USDC",
    participants: "2,108 savers",
    deadline: "Opens for lock-in tomorrow at 09:00 UTC",
    progress: 58,
    nextAction: "Monitor deposit velocity before the next lock window.",
  },
  {
    name: "BTC Reserve Round",
    status: "locking",
    pool: "980 BTC",
    participants: "1,240 savers",
    deadline: "Locks in 2 days and 4 hours",
    progress: 84,
    nextAction: "Confirm settlement checks before freeze.",
  },
];

const OPERATIONAL_NOTES = [
  {
    title: "Settlement window",
    body: "Avoid manual writes between 14:00 and 15:00 UTC while the payout job is active.",
  },
  {
    title: "Escalation rule",
    body: "Page the protocol owner if the indexer stays more than 5 ledgers behind for 10 minutes.",
  },
  {
    title: "Change hygiene",
    body: "Attach screenshots or transaction receipts for every admin parameter update.",
  },
  {
    title: "Release check",
    body: "Clear any draft governance actions after execution so the dashboard stays current.",
  },
];

const ROUND_STATUS_STYLE = {
  drawing: {
    label: "Drawing",
    className: "bg-fuchsia-500/15 text-fuchsia-300 ring-fuchsia-400/30",
    icon: Gauge,
  },
  open: {
    label: "Open",
    className: "bg-emerald-500/15 text-emerald-300 ring-emerald-400/30",
    icon: CheckCircle2,
  },
  locking: {
    label: "Locking",
    className: "bg-amber-500/15 text-amber-300 ring-amber-400/30",
    icon: Clock3,
  },
};

const HEALTH_LABEL = {
  healthy: "Healthy",
  stale: "Stale",
  degraded: "Degraded",
};

const HEALTH_ICON = {
  healthy: CheckCircle2,
  stale: Clock3,
  degraded: AlertTriangle,
};

const HEALTH_POLL_MS = 30_000;

function RoundStatusBadge({ status }) {
  const style = ROUND_STATUS_STYLE[status] ?? ROUND_STATUS_STYLE.open;
  const Icon = style.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${style.className}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {style.label}
    </span>
  );
}

function HealthBadge({ status }) {
  const normalized = HEALTH_LABEL[status] ? status : "degraded";
  const styles = getStatusBadgeStyles(normalized);
  const Icon = HEALTH_ICON[normalized] ?? AlertTriangle;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${styles.badge}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {HEALTH_LABEL[normalized]}
    </span>
  );
}

function MetricCard({ label, value, detail, icon: Icon }) {
  return (
    <div className="vq-glass p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.24em] text-vault-muted">
            {label}
          </p>
          <p className="mt-2 text-2xl font-bold text-vault-text">{value}</p>
          <p className="mt-1 text-sm text-vault-muted">{detail}</p>
        </div>
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-red-500/20 bg-red-500/10 text-red-400">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
      </div>
    </div>
  );
}

function formatCheckedAt(iso) {
  if (!iso) return "Not checked yet";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Not checked yet";
  return date.toLocaleTimeString();
}

export default function AdminSettingsPage() {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const activeRequest = useRef(null);

  const loadHealth = useCallback(async () => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const isCurrent = () => activeRequest.current === controller && !controller.signal.aborted;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/health", {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        throw new Error("Admin health endpoint returned invalid JSON");
      }
      if (!payload || typeof payload !== "object" || !Array.isArray(payload.dependencies)) {
        throw new Error("Admin health endpoint returned an invalid payload");
      }
      // A prior request may finish parsing even after its fetch was aborted.
      if (isCurrent()) setHealth(payload);
    } catch (err) {
      if (!isCurrent()) return;
      setHealth(null);
      setError(err instanceof Error ? err.message : "Unable to load live dependency health");
    } finally {
      if (isCurrent()) {
        activeRequest.current = null;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    loadHealth();
    const interval = setInterval(loadHealth, HEALTH_POLL_MS);
    return () => {
      clearInterval(interval);
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, [loadHealth]);

  const dependencies = health?.dependencies ?? [];
  const healthyCount = health?.summary?.healthy ?? 0;
  const totalDeps = health?.summary?.total ?? dependencies.length;
  const overallStatus = error ? "degraded" : health?.status;
  const drift = health?.configDrift;

  const totals = {
    parameters: PROTOCOL_PARAMETERS.length,
    rounds: ACTIVE_ROUNDS.length,
    services: totalDeps || 4,
    notes: OPERATIONAL_NOTES.length,
  };

  return (
    <div className="space-y-6">
      <motion.header
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="flex flex-col gap-4 rounded-3xl border border-vault-border bg-gradient-to-br from-[#2B0B0B] via-vault-surface to-vault-bg p-6 shadow-glass sm:flex-row sm:items-end sm:justify-between"
      >
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.32em] text-red-300">
            Admin console
          </p>
          <h1 className="text-3xl font-bold text-vault-text">Settings Overview</h1>
          <p className="max-w-2xl text-sm text-vault-muted">
            Review protocol parameters, active rounds, live dependency health, and the
            current operating notes before making a governance change.
          </p>
          <div className="flex flex-wrap gap-2 pt-1 text-xs text-vault-muted">
            <span className="rounded-full border border-vault-border bg-vault-surface px-3 py-1.5">
              Live dependency probes
            </span>
            <span className="rounded-full border border-vault-border bg-vault-surface px-3 py-1.5">
              Changes flow through governance proposals
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link href="/app/admin/proposals" className="vq-btn-ghost inline-flex items-center gap-2">
            <Shield className="h-4 w-4" aria-hidden="true" />
            View proposals
          </Link>
          <Link href="/app/prizes" className="vq-btn-primary inline-flex items-center gap-2">
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
            Review public rounds
          </Link>
        </div>
      </motion.header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Protocol parameters"
          value={String(totals.parameters)}
          detail="Core settings currently enforced on chain and in the backend."
          icon={Settings}
        />
        <MetricCard
          label="Active rounds"
          value={String(totals.rounds)}
          detail="Open, locking, and drawing rounds currently under management."
          icon={SquareStack}
        />
        <MetricCard
          label="Live health"
          value={error ? "Unavailable" : loading && !health ? "…" : `${healthyCount}/${totals.services}`}
          detail="Dependencies currently reporting healthy."
          icon={Server}
        />
        <MetricCard
          label="Operational notes"
          value={String(totals.notes)}
          detail="Current reminders, escalation rules, and release hygiene."
          icon={Shield}
        />
      </div>

      <section className="vq-glass p-5 sm:p-6" aria-label="Live dependency health">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-vault-text">Live dependency health</h2>
            <p className="mt-1 text-sm text-vault-muted">
              RPC, indexer, contract WASM hash, and config drift — refreshed every 30s.
            </p>
            <p className="mt-2 text-xs text-vault-muted">
              Last checked: {formatCheckedAt(health?.checkedAt)} · Overall{" "}
              <span className="font-medium text-vault-text">{HEALTH_LABEL[overallStatus] ?? "Checking"}</span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            {overallStatus ? (
              <HealthBadge status={overallStatus} />
            ) : (
              <span className="text-sm text-vault-muted">Checking</span>
            )}
            <button
              type="button"
              onClick={loadHealth}
              disabled={loading}
              className="vq-btn-ghost inline-flex h-9 items-center gap-2 px-3 disabled:opacity-60"
              aria-label="Refresh health"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
              Refresh
            </button>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="mt-4 flex items-start gap-2 rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-300"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        )}

        <div className="mt-5 space-y-3">
          {loading && !dependencies.length && (
            <p className="text-sm text-vault-muted">Probing live dependencies…</p>
          )}
          {dependencies.map((dep) => {
            const styles = getStatusBadgeStyles(dep.status);
            return (
              <div
                key={dep.id}
                className="flex flex-col gap-3 rounded-2xl border border-vault-border bg-vault-surface/40 p-4 sm:flex-row sm:items-start sm:justify-between"
                data-testid={`health-dep-${dep.id}`}
                data-status={dep.status}
              >
                <div className="flex items-start gap-3">
                  <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${styles.iconAvatar}`}>
                    <Server className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div>
                    <p className="font-medium text-vault-text">{dep.name}</p>
                    <p className="mt-1 text-sm text-vault-muted">{dep.detail}</p>
                    {typeof dep.latencyMs === "number" && (
                      <p className="mt-1 text-xs text-vault-muted">{dep.latencyMs}ms</p>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  <HealthBadge status={dep.status} />
                  {dep.remediationUrl && (
                    <a
                      href={dep.remediationUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-medium text-red-300 hover:underline"
                    >
                      Remediation
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {drift?.hasDrift && (
          <div
            className="mt-6 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4"
            data-testid="config-drift-panel"
            role="region"
            aria-label="Configuration drift"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-vault-text">Configuration drift</h3>
              <HealthBadge status={drift.status} />
            </div>
            <p className="mt-1 text-sm text-vault-muted">
              Runtime values diverge from canonical deployment provenance.
            </p>
            <ul className="mt-4 space-y-3">
              {drift.drifts.map((item) => (
                <li
                  key={item.parameter}
                  className="rounded-xl border border-vault-border bg-vault-bg/40 p-3 text-sm"
                  data-testid={`drift-${item.parameter}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium text-vault-text">{item.parameter}</p>
                    <span className="text-xs uppercase tracking-wide text-vault-muted">
                      {item.severity}
                    </span>
                  </div>
                  <p className="mt-1 text-vault-muted">
                    expected <span className="text-vault-text">{item.expected}</span>
                    {" · "}
                    actual <span className="text-vault-text">{item.actual}</span>
                  </p>
                  <p className="mt-1 text-xs text-vault-muted">{item.impact}</p>
                </li>
              ))}
            </ul>
            {drift.remediationUrl && (
              <a
                href={drift.remediationUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-red-300 hover:underline"
              >
                Open config-drift remediation
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            )}
          </div>
        )}
      </section>

      <section className="vq-glass p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-vault-text">Protocol parameters</h2>
            <p className="mt-1 text-sm text-vault-muted">
              The most important configuration knobs that define how the protocol behaves.
            </p>
          </div>
          <span className="inline-flex items-center gap-2 rounded-full border border-vault-border bg-vault-surface px-3 py-1.5 text-xs font-medium text-vault-muted">
            <Gauge className="h-3.5 w-3.5" aria-hidden="true" />
            Governance-controlled
          </span>
        </div>

        <div className="mt-5 overflow-hidden rounded-2xl border border-vault-border">
          <table className="min-w-full divide-y divide-vault-border text-left text-sm">
            <thead className="bg-vault-surface/60 text-xs uppercase tracking-wide text-vault-muted">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Parameter</th>
                <th scope="col" className="px-4 py-3 font-medium">Current value</th>
                <th scope="col" className="px-4 py-3 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-vault-border bg-vault-bg/40">
              {PROTOCOL_PARAMETERS.map((item) => (
                <tr key={item.label} className="align-top">
                  <th scope="row" className="px-4 py-4 font-medium text-vault-text">
                    {item.label}
                  </th>
                  <td className="px-4 py-4 text-vault-text">{item.value}</td>
                  <td className="px-4 py-4 text-vault-muted">{item.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
        <section className="vq-glass p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-vault-text">Active rounds</h2>
              <p className="mt-1 text-sm text-vault-muted">
                Operational snapshot for the rounds currently being managed.
              </p>
            </div>
            <Clock3 className="h-5 w-5 text-red-400" aria-hidden="true" />
          </div>

          <div className="mt-5 space-y-4">
            {ACTIVE_ROUNDS.map((round) => (
              <article
                key={round.name}
                className="rounded-2xl border border-vault-border bg-vault-surface/40 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-semibold text-vault-text">{round.name}</h3>
                      <RoundStatusBadge status={round.status} />
                    </div>
                    <p className="mt-1 text-sm text-vault-muted">{round.deadline}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold text-vault-text">{round.pool}</p>
                    <p className="text-xs uppercase tracking-[0.24em] text-vault-muted">
                      Pool size
                    </p>
                  </div>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-vault-border bg-vault-bg/40 p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-vault-muted">
                      Participants
                    </p>
                    <p className="mt-1 text-sm font-medium text-vault-text">{round.participants}</p>
                  </div>
                  <div className="rounded-xl border border-vault-border bg-vault-bg/40 p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-vault-muted">
                      Next action
                    </p>
                    <p className="mt-1 text-sm font-medium text-vault-text">{round.nextAction}</p>
                  </div>
                </div>

                <div className="mt-4">
                  <div className="mb-2 flex items-center justify-between text-xs text-vault-muted">
                    <span>Round progress</span>
                    <span>{round.progress}%</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-vault-border/40">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-red-500 to-amber-400"
                      style={{ width: `${round.progress}%` }}
                    />
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="vq-glass p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-vault-text">Operational notes</h2>
              <p className="mt-1 text-sm text-vault-muted">
                A lightweight runbook for the current protocol cycle.
              </p>
            </div>
            <CheckCircle2 className="h-5 w-5 text-emerald-400" aria-hidden="true" />
          </div>

          <div className="mt-5 space-y-3">
            {OPERATIONAL_NOTES.map((note, index) => (
              <div
                key={note.title}
                className="flex items-start gap-3 rounded-2xl border border-vault-border bg-vault-surface/40 p-4"
              >
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-red-500/10 text-xs font-semibold text-red-300">
                  {index + 1}
                </span>
                <div>
                  <p className="font-medium text-vault-text">{note.title}</p>
                  <p className="mt-1 text-sm text-vault-muted">{note.body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
