"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Check, Loader2, Server, X } from "lucide-react";
import { avalanche, avalancheFuji } from "wagmi/chains";
import {
  DEFAULT_RPC,
  pingEvmRpc,
  pingHorizon,
  readStoredRpc,
  RPC_UPDATED_EVENT,
  writeStoredRpc,
} from "@/lib/customRpc";

export const STELLAR_FIELDS = [
  {
    key: "horizon",
    label: "Stellar Horizon URL",
    placeholder: DEFAULT_RPC.horizon,
    hint: "Validated via Horizon root endpoint and must match the configured network passphrase.",
    ping: (url) => pingHorizon(url),
  },
];

export const AVALANCHE_FIELDS = [
  {
    key: "avalanche",
    label: "Avalanche C-Chain RPC",
    placeholder: DEFAULT_RPC.avalanche,
    hint: "Validated via eth_chainId and must match the Avalanche C-Chain ID.",
    ping: (url) => pingEvmRpc(url, avalanche.id),
  },
  {
    key: "avalancheFuji",
    label: "Avalanche Fuji RPC",
    placeholder: DEFAULT_RPC.avalancheFuji,
    hint: "Validated via eth_chainId and must match the Avalanche Fuji chain ID.",
    ping: (url) => pingEvmRpc(url, avalancheFuji.id),
  },
];

/** @param {{ open: boolean, onClose: () => void, network?: string }} props */
export default function CustomRpcModal({ open, onClose, network = "stellar" }) {
  const [activeNetwork, setActiveNetwork] = useState(network);
  const [values, setValues] = useState({ ...DEFAULT_RPC });
  const [status, setStatus] = useState(
    /** @type {Record<string, 'idle' | 'testing' | 'ok' | 'error'>} */ ({})
  );
  const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
  const [diagnostics, setDiagnostics] = useState("");

  useEffect(() => {
    if (!open) return;
    const stored = readStoredRpc();
    setValues(stored ?? { ...DEFAULT_RPC });
    setActiveNetwork(network);
    setStatus({});
    setErrors({});
    setDiagnostics("");
  }, [network, open]);

  const activeFields = activeNetwork === "stellar" ? STELLAR_FIELDS : AVALANCHE_FIELDS;

  const setField = useCallback((key, value) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setStatus((prev) => ({ ...prev, [key]: "idle" }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const testField = useCallback(
    async (field) => {
      const url = values[field.key]?.trim();
      if (!url) {
        setStatus((s) => ({ ...s, [field.key]: "error" }));
        setErrors((e) => ({ ...e, [field.key]: "URL is required" }));
        return false;
      }
      setStatus((s) => ({ ...s, [field.key]: "testing" }));
      const result = await field.ping(url);
      if (result.ok) {
        setStatus((s) => ({ ...s, [field.key]: "ok" }));
        setErrors((e) => {
          const next = { ...e };
          delete next[field.key];
          return next;
        });
        return true;
      }
      setStatus((s) => ({ ...s, [field.key]: "error" }));
      setErrors((e) => ({ ...e, [field.key]: result.error ?? "Validation failed" }));
      return false;
    },
    [values]
  );

  const handleSave = useCallback(async () => {
    setDiagnostics("Running connection tests…");
    const results = await Promise.all(activeFields.map((f) => testField(f)));
    if (!results.every(Boolean)) {
      setDiagnostics("Fix failed endpoints before saving. Invalid URLs are rejected.");
      return;
    }
    const stored = writeStoredRpc(values);
    setDiagnostics(
      `All ${activeNetwork === "stellar" ? "Stellar" : "Avalanche"} endpoints validated. Settings saved.`
    );
    window.dispatchEvent(new CustomEvent(RPC_UPDATED_EVENT, { detail: stored }));
    onClose();
  }, [activeFields, activeNetwork, onClose, testField, values]);

  const handleReset = useCallback(() => {
    setValues((prev) => {
      const next = { ...prev };
      for (const field of activeFields) {
        next[field.key] = DEFAULT_RPC[field.key];
      }
      return next;
    });
    setStatus({});
    setErrors({});
    setDiagnostics("Reset active network endpoints to defaults. Save to apply.");
  }, [activeFields]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rpc-modal-title"
      data-testid="custom-rpc-modal"
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        aria-label="Close RPC settings"
        onClick={onClose}
      />
      <div className="relative z-10 w-full max-w-lg rounded-2xl border border-vault-border bg-vault-bg p-6 shadow-glass">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="rpc-modal-title" className="flex items-center gap-2 text-lg font-semibold text-vault-text">
              <Server className="h-5 w-5 text-red-500" aria-hidden="true" />
              Custom RPC settings
            </h2>
            <p className="mt-1 text-sm text-vault-muted">
              Configure independent node overrides for Stellar or Avalanche networks.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-vault-muted hover:text-vault-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Network Adapter Tabs */}
        <div className="mt-4 flex gap-2 border-b border-vault-border/50 pb-2">
          <button
            type="button"
            onClick={() => {
              setActiveNetwork("stellar");
              setDiagnostics("");
            }}
            data-testid="rpc-tab-stellar"
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
              activeNetwork === "stellar"
                ? "border border-red-500/30 bg-red-500/15 text-red-500"
                : "text-vault-muted hover:text-vault-text"
            }`}
          >
            Stellar Horizon
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveNetwork("avalanche");
              setDiagnostics("");
            }}
            data-testid="rpc-tab-avalanche"
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
              activeNetwork === "avalanche"
                ? "border border-red-500/30 bg-red-500/15 text-red-500"
                : "text-vault-muted hover:text-vault-text"
            }`}
          >
            Avalanche C-Chain
          </button>
        </div>

        <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-vault-muted">
          A custom node can see every account address you query and transaction you submit. Only use trusted
          HTTPS endpoints.
        </p>

        <div className="mt-5 space-y-4">
          {activeFields.map((field) => (
            <div key={field.key}>
              <label htmlFor={`rpc-${field.key}`} className="text-sm font-medium text-vault-text">
                {field.label}
              </label>
              <div className="mt-1 flex gap-2">
                <div className="relative min-w-0 flex-1">
                  <input
                    id={`rpc-${field.key}`}
                    type="url"
                    value={values[field.key]}
                    onChange={(e) => setField(field.key, e.target.value)}
                    placeholder={field.placeholder}
                    className="w-full rounded-xl border border-vault-border bg-vault-surface py-2.5 pl-3 pr-10 text-sm text-vault-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
                    {status[field.key] === "testing" && (
                      <Loader2 className="h-4 w-4 animate-spin text-vault-muted" aria-hidden="true" />
                    )}
                    {status[field.key] === "ok" && (
                      <Check className="h-4 w-4 text-emerald-500" aria-label="Validated" />
                    )}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => testField(field)}
                  disabled={status[field.key] === "testing"}
                  data-testid={`test-btn-${field.key}`}
                  className="shrink-0 rounded-xl border border-vault-border bg-vault-surface px-3 py-2 text-xs font-medium text-vault-text hover:border-red-400/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50"
                >
                  Test
                </button>
              </div>
              <p className="mt-1 text-xs text-vault-muted">{field.hint}</p>
              {errors[field.key] && (
                <p className="mt-1 text-xs text-red-600 dark:text-red-400" role="alert">
                  {errors[field.key]}
                </p>
              )}
            </div>
          ))}
        </div>

        {diagnostics && (
          <p
            className="mt-4 rounded-lg border border-vault-border bg-vault-surface/80 px-3 py-2 text-xs text-vault-muted"
            role="status"
            aria-live="polite"
            data-testid="rpc-diagnostics"
          >
            {diagnostics}
          </p>
        )}

        <div className="mt-6 flex flex-wrap gap-2">
          <button type="button" onClick={handleSave} className="vq-btn-primary" data-testid="save-rpc-btn">
            Save & apply
          </button>
          <button type="button" onClick={handleReset} className="vq-btn-ghost" data-testid="reset-rpc-btn">
            Reset defaults
          </button>
          <button type="button" onClick={onClose} className="vq-btn-ghost" data-testid="cancel-rpc-btn">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
