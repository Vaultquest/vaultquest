"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Bell, CheckCircle2, AlertCircle, ShieldCheck } from "lucide-react";
import {
  connectedPublicKey,
} from "@vaultquest/stellar-wallet-connect/src/core/store";
import {
  DEFAULT_PREFS,
  loadNotificationPrefs,
  saveNotificationPrefs,
  OPTIONAL_PREF_KEYS,
} from "@/lib/notification-prefs";
import {
  loadNotificationPreferences,
  saveNotificationPreferences,
} from "@/lib/notification-prefs-client";

function useNanostoreValue(store, fallback) {
  const [value, setValue] = useState(() => {
    try {
      return store?.get?.() ?? fallback;
    } catch {
      return fallback;
    }
  });

  useEffect(() => {
    if (!store || typeof store.subscribe !== "function") return undefined;
    setValue(store.get?.() ?? fallback);
    return store.subscribe((next) => setValue(next ?? fallback));
  }, [store, fallback]);

  return value;
}

const TOGGLE_ROWS = [
  {
    key: "roundUpdates",
    title: "Round Updates",
    description: "Get notified when draw actions complete",
  },
  {
    key: "actionStatus",
    title: "Action Status Updates",
    description: "Deposits, withdrawals, and claims",
  },
  {
    key: "winnings",
    title: "Prize Claim Notifications",
    description: "Get notified when prize claims are confirmed",
  },
  {
    key: "deposits",
    title: "Deposit Confirmations",
    description: "Confirm each deposit action",
  },
];

export default function VaultNotificationSettings({
  storage,
  fetchImpl,
  signMessage,
} = {}) {
  const wallet = useNanostoreValue(connectedPublicKey, "");
  const browserStorage = useMemo(() => {
    if (storage !== undefined) return storage;
    try {
      return typeof window !== "undefined" ? window.localStorage : null;
    } catch {
      return null;
    }
  }, [storage]);
  const [settings, setSettings] = useState({ ...DEFAULT_PREFS });
  const [stateWallet, setStateWallet] = useState("");
  const [showSaved, setShowSaved] = useState(false);
  const [error, setError] = useState(null);
  const [cacheNotice, setCacheNotice] = useState(null);
  const [pending, setPending] = useState(null);
  const [loadedWallet, setLoadedWallet] = useState("");
  const [revision, setRevision] = useState(null);
  const request = useRef({ generation: 0, controller: null, pending: false });
  const cacheWritable = useRef(true);

  useEffect(() => {
    request.current.controller?.abort();
    request.current = { generation: request.current.generation + 1, controller: null, pending: false };
    setStateWallet(wallet);
    setLoadedWallet("");
    setRevision(null);
    setPending(null);
    setError(null);
    setShowSaved(false);
    setCacheNotice(null);
    setSettings({ ...DEFAULT_PREFS });
    cacheWritable.current = true;
    if (wallet && browserStorage) {
      const local = loadNotificationPrefs(browserStorage, wallet);
      if (local.ok && local.record) {
        setSettings({ ...DEFAULT_PREFS, ...local.record.prefs });
      } else if (local.reason === "newer-version" || local.reason === "corrupt") {
        cacheWritable.current = false;
        setCacheNotice("The existing browser copy was left untouched. Load the server copy to manage your preferences.");
      }
    }
    return () => {
      request.current.controller?.abort();
      request.current.generation += 1;
    };
  }, [wallet, browserStorage]);

  const currentSettings = stateWallet === wallet ? settings : DEFAULT_PREFS;
  const isLoaded = Boolean(wallet && loadedWallet === wallet && revision !== null);
  const isBusy = Boolean(pending && stateWallet === wallet);

  const cacheRecord = (record) => {
    if (!browserStorage || !cacheWritable.current) return;
    const saved = saveNotificationPrefs(browserStorage, record.wallet, record.prefs, record.updatedAt);
    if (!saved.ok) {
      setCacheNotice("Preferences are stored on the server, but this browser could not cache them.");
    }
  };

  const performRequest = async (kind) => {
    if (!wallet || request.current.pending || (kind === "save" && !isLoaded)) return;
    request.current.controller?.abort();
    const controller = new AbortController();
    const generation = request.current.generation + 1;
    request.current = { generation, controller, pending: true };
    const isCurrent = () => request.current.generation === generation && connectedPublicKey.get() === wallet;
    setPending(kind);
    setError(null);
    setShowSaved(false);
    try {
      const options = { fetchImpl, signMessage, signal: controller.signal, isCurrent };
      const record = kind === "load"
        ? await loadNotificationPreferences(wallet, options)
        : await saveNotificationPreferences(wallet, currentSettings, revision, options);
      if (!isCurrent()) return;
      setSettings({ ...record.prefs });
      setStateWallet(wallet);
      setLoadedWallet(wallet);
      setRevision(record.revision);
      cacheRecord(record);
      setShowSaved(kind === "save");
    } catch (err) {
      if (!isCurrent()) return;
      if (err?.status === 409) {
        setRevision(null);
        setError("Preferences changed elsewhere. Load saved preferences, then apply your changes again.");
      } else {
        setError(err?.name === "AbortError"
          ? "The notification service did not respond in time. Try again."
          : err?.message || "The wallet request could not be completed. Try again.");
      }
    } finally {
      if (isCurrent()) {
        request.current.pending = false;
        setPending(null);
      }
    }
  };

  const toggleSetting = (key) => {
    if (!isLoaded || isBusy || !OPTIONAL_PREF_KEYS.includes(key)) return;
    setSettings((prev) => ({ ...prev, [key]: !prev[key] }));
    setShowSaved(false);
    setError(null);
  };

  return (
    <section className="vq-glass-hover p-6 space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-vault-accent/10 text-vault-accent border border-vault-accent/20">
          <Bell size={20} />
        </div>
        <div>
          <h3 className="font-semibold text-vault-text">
            Notification Preferences
          </h3>
          <p className="text-sm text-vault-muted">
            {wallet
              ? "Manage vault alerts for the connected wallet"
              : "Connect a wallet to load and save preferences"}
          </p>
        </div>
      </div>

      {wallet && !isLoaded && (
        <div className="space-y-2 text-sm text-vault-muted">
          <p>Load saved preferences by approving a wallet message. This does not submit a transaction.</p>
          <button
            type="button"
            onClick={() => performRequest("load")}
            disabled={isBusy}
            className="vq-btn-primary w-full disabled:opacity-60"
          >
            {pending === "load" ? "Loading preferences…" : "Load saved preferences"}
          </button>
        </div>
      )}

      <div className="space-y-3 border-t border-vault-border pt-4">
        {TOGGLE_ROWS.map((row) => (
          <label
            key={row.key}
            className="flex items-center justify-between cursor-pointer group"
          >
            <div>
              <p className="font-medium text-vault-text group-hover:text-vault-accent transition-colors">
                {row.title}
              </p>
              <p className="text-xs text-vault-muted">{row.description}</p>
            </div>
            <input
              type="checkbox"
              checked={Boolean(currentSettings[row.key])}
              onChange={() => toggleSetting(row.key)}
              disabled={!isLoaded || isBusy}
              aria-label={row.title}
              className="h-5 w-5 rounded border-vault-border text-vault-accent focus:ring-2 focus:ring-vault-accent"
            />
          </label>
        ))}

        <div className="flex items-start justify-between gap-3 rounded-xl border border-vault-border bg-vault-surface/40 p-3">
          <div className="flex items-start gap-2">
            <ShieldCheck size={18} className="mt-0.5 text-vault-accent shrink-0" />
            <div>
              <p className="font-medium text-vault-text">Security notices</p>
              <p className="text-xs text-vault-muted">
                Mandatory alerts for account security stay on and cannot be disabled.
              </p>
            </div>
          </div>
          <input
            type="checkbox"
            checked
            disabled
            readOnly
            aria-label="Security notices (required)"
            className="h-5 w-5 rounded border-vault-border text-vault-accent opacity-70"
          />
        </div>
      </div>

      <button
        type="button"
        onClick={() => performRequest("save")}
        disabled={isBusy || !isLoaded}
        className="vq-btn-primary w-full disabled:opacity-60"
      >
        {pending === "save" ? "Saving…" : "Save Preferences"}
      </button>

      {showSaved && isLoaded && (
        <div role="status" className="flex items-center gap-2 text-sm text-emerald-500 bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3">
          <CheckCircle2 size={16} />
          <span>
            Notification preferences saved
            {loadedWallet ? " for this wallet" : ""}
          </span>
        </div>
      )}

      {cacheNotice && stateWallet === wallet && (
        <p role="status" className="text-sm text-vault-muted">{cacheNotice}</p>
      )}

      {error && stateWallet === wallet && (
        <div role="alert" className="flex items-start gap-2 text-sm text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg p-3">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </section>
  );
}
