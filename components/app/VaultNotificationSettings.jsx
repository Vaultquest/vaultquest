"use client";

import React, { useCallback, useEffect, useState } from "react";
import { AlertCircle, Bell, CheckCircle2, Lock, ShieldCheck, Wallet } from "lucide-react";
import { connectedPublicKey } from "@vaultquest/stellar-wallet-connect/src/core/store";
import { useAccount } from "wagmi";
import {
  DEFAULT_PREFERENCES,
  MANDATORY_SECURITY_NOTICES,
  OPTIONAL_PREFERENCE_FIELDS,
  PREFS_UPDATED_EVENT,
  getNotificationPreferences,
  saveNotificationPreferences,
} from "@/lib/notificationPreferences";

function useNanostoreValue(store, fallback) {
  const [value, setValue] = useState(fallback);

  useEffect(() => {
    if (!store || typeof store.get !== "function") return;
    setValue(store.get());
    return store.subscribe(setValue);
  }, [store]);

  return value;
}

function truncateWallet(address) {
  if (!address || typeof address !== "string") return "";
  const trimmed = address.trim();
  if (trimmed.length <= 10) return trimmed;
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

export default function VaultNotificationSettings({ walletAddress: propWalletAddress } = {}) {
  const stellarAddress = useNanostoreValue(connectedPublicKey, "");
  const { address: wagmiAddress } = useAccount();

  const activeWallet = propWalletAddress || stellarAddress || wagmiAddress || "";

  const [settings, setSettings] = useState(() => getNotificationPreferences(activeWallet));
  const [statusFeedback, setStatusFeedback] = useState(null);
  const [isSaving, setIsSaving] = useState(false);

  // Sync preferences when active wallet changes
  useEffect(() => {
    setSettings(getNotificationPreferences(activeWallet));
    setStatusFeedback(null);
  }, [activeWallet]);

  // Listen for storage events or custom update events across windows/components
  useEffect(() => {
    const handleUpdate = (event) => {
      const updatedWallet = event?.detail?.walletAddress;
      if (!activeWallet || !updatedWallet) return;
      if (updatedWallet.toLowerCase() === activeWallet.toLowerCase()) {
        setSettings(getNotificationPreferences(activeWallet));
      }
    };

    window.addEventListener(PREFS_UPDATED_EVENT, handleUpdate);
    return () => window.removeEventListener(PREFS_UPDATED_EVENT, handleUpdate);
  }, [activeWallet]);

  const toggleSetting = useCallback((key) => {
    setSettings((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const handleSave = () => {
    setIsSaving(true);
    try {
      if (!activeWallet) {
        setStatusFeedback({
          type: "error",
          message: "Connect your wallet first to persist notification preferences.",
        });
        return;
      }

      saveNotificationPreferences(activeWallet, settings);
      setStatusFeedback({
        type: "success",
        message: `Preferences saved for ${truncateWallet(activeWallet)}.`,
      });
    } catch (err) {
      setStatusFeedback({
        type: "error",
        message: err?.message || "Failed to save preferences to local storage.",
      });
    } finally {
      setIsSaving(false);
      setTimeout(() => {
        setStatusFeedback(null);
      }, 4000);
    }
  };

  return (
    <section
      aria-labelledby="notif-settings-heading"
      className="vq-glass-hover p-6 space-y-5 rounded-2xl border border-vault-border"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-vault-accent/10 text-vault-accent border border-vault-accent/20">
            <Bell size={20} aria-hidden="true" />
          </div>
          <div>
            <h3 id="notif-settings-heading" className="font-semibold text-vault-text text-base">
              Notification Preferences
            </h3>
            <p className="text-sm text-vault-muted">Manage your vault alerts and delivery rules</p>
          </div>
        </div>

        {activeWallet ? (
          <div
            data-testid="active-wallet-badge"
            className="flex items-center gap-2 self-start sm:self-auto rounded-lg bg-vault-card/60 px-3 py-1.5 border border-vault-border text-xs text-vault-text"
          >
            <Wallet className="h-3.5 w-3.5 text-vault-accent" />
            <span className="font-mono">{truncateWallet(activeWallet)}</span>
          </div>
        ) : (
          <div
            data-testid="no-wallet-badge"
            className="flex items-center gap-1.5 self-start sm:self-auto rounded-lg bg-amber-500/10 px-3 py-1.5 border border-amber-500/20 text-xs text-amber-400"
          >
            <Wallet className="h-3.5 w-3.5" />
            <span>Wallet disconnected</span>
          </div>
        )}
      </div>

      {!activeWallet && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-300 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            Connect your wallet to persist preferences across sessions. Current changes apply only to this preview session.
          </span>
        </div>
      )}

      {/* Mandatory Security Notices Section */}
      <div className="rounded-xl border border-vault-border/80 bg-vault-card/40 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium text-vault-text">
            <ShieldCheck className="h-4 w-4 text-emerald-400" />
            <span>Mandatory Security Notices</span>
          </div>
          <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400 border border-emerald-500/20">
            <Lock className="h-3 w-3" />
            Always Active
          </span>
        </div>
        <p className="text-xs text-vault-muted">
          Critical security alerts, signer threshold modifications, and emergency pause events are always enforced.
        </p>

        <div className="space-y-2.5 pt-1">
          {MANDATORY_SECURITY_NOTICES.map((notice) => (
            <div
              key={notice.key}
              className="flex items-center justify-between p-2.5 rounded-lg bg-vault-bg/40 border border-vault-border/50 text-xs"
            >
              <div className="space-y-0.5 pr-2">
                <p className="font-medium text-vault-text">{notice.label}</p>
                <p className="text-[11px] text-vault-muted leading-tight">{notice.description}</p>
              </div>
              <input
                type="checkbox"
                checked={true}
                disabled={true}
                readOnly
                aria-label={`${notice.label} (mandatory)`}
                className="h-4 w-4 rounded border-vault-border text-emerald-500 opacity-80 cursor-not-allowed"
              />
            </div>
          ))}
        </div>
      </div>

      {/* Optional Notifications Section */}
      <div className="space-y-3 border-t border-vault-border pt-4">
        <div className="text-xs font-semibold uppercase tracking-wider text-vault-muted">
          Customizable Alerts
        </div>

        {OPTIONAL_PREFERENCE_FIELDS.map((field) => (
          <label
            key={field.key}
            className="flex items-center justify-between cursor-pointer group p-2 rounded-lg hover:bg-vault-card/30 transition-colors"
          >
            <div className="space-y-0.5 pr-4">
              <p className="font-medium text-vault-text text-sm group-hover:text-vault-accent transition-colors">
                {field.label}
              </p>
              <p className="text-xs text-vault-muted">{field.description}</p>
            </div>
            <input
              type="checkbox"
              aria-label={field.label}
              checked={Boolean(settings[field.key])}
              onChange={() => toggleSetting(field.key)}
              className="h-5 w-5 rounded border-vault-border text-vault-accent focus:ring-2 focus:ring-vault-accent cursor-pointer"
            />
          </label>
        ))}
      </div>

      <button
        type="button"
        onClick={handleSave}
        disabled={isSaving}
        className="vq-btn-primary w-full transition-all disabled:opacity-50"
      >
        {isSaving ? "Saving..." : "Save Preferences"}
      </button>

      {statusFeedback && (
        <div
          role="alert"
          className={`flex items-center gap-2 text-sm rounded-lg p-3 border ${
            statusFeedback.type === "success"
              ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
              : "text-rose-400 bg-rose-500/10 border-rose-500/20"
          }`}
        >
          {statusFeedback.type === "success" ? (
            <CheckCircle2 size={16} className="shrink-0" />
          ) : (
            <AlertCircle size={16} className="shrink-0" />
          )}
          <span>{statusFeedback.message}</span>
        </div>
      )}
    </section>
  );
}
