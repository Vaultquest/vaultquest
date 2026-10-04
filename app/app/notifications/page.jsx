"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { connectedPublicKey } from "@/stellar-wallet-connect/src/core/store";
import { requestWalletNotification } from "@/lib/notification-prefs-client";
import Link from "next/link";
import { Bell, Check, CheckCircle2, Clock, Inbox, MailOpen } from "lucide-react";


function formatNotificationDate(dateValue, formatter) {
  const date = new Date(dateValue);
  // Intl.format throws for invalid dates; keep the previous display behavior.
  return Number.isNaN(date.getTime()) ? "Invalid Date" : formatter.format(date);
}

export default function VaultNotificationsPage() {
  const [wallet, setWallet] = useState(() => connectedPublicKey.get() || "");
  const [items, setItems] = useState([]);
  const [itemsWallet, setItemsWallet] = useState("");
  const [readIds, setReadIds] = useState(new Set());
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(null);

  useEffect(() => connectedPublicKey.subscribe(value => setWallet(value || "")), []);
  useEffect(() => {
    request.current?.abort();
    setItems([]);
    setItemsWallet("");
    setReadIds(new Set());
    setLoaded(false);
    setLoading(false);
    setError("");
    return () => request.current?.abort();
  }, [wallet]);

  const loadNotifications = async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const requestedWallet = wallet;
    setLoading(true);
    setError("");
    try {
      const result = await requestWalletNotification(
        `/api/notifications?wallet=${encodeURIComponent(requestedWallet)}`,
        { wallet: requestedWallet, signal: controller.signal },
      );
      if (controller.signal.aborted || connectedPublicKey.get() !== requestedWallet) return;
      if (!Array.isArray(result.data)) throw new Error("Invalid notification history response.");
      setItems(result.data);
      setItemsWallet(requestedWallet);
      setLoaded(true);
    } catch (err) {
      if (!controller.signal.aborted && connectedPublicKey.get() === requestedWallet) {
        setError(err.message || "Notifications could not be loaded.");
      }
    } finally {
      if (!controller.signal.aborted && connectedPublicKey.get() === requestedWallet) setLoading(false);
    }
  };

  const notifications = useMemo(() => (itemsWallet === wallet ? items : []).map(notification => ({
    ...notification,
    status: readIds.has(notification.id) ? "read" : "unread",
  })), [items, itemsWallet, wallet, readIds]);

  const visibleNotifications = useMemo(() => {
    if (!showUnreadOnly) return notifications;
    return notifications.filter((notification) => notification.status === "unread");
  }, [notifications, showUnreadOnly]);

  const groupedNotifications = useMemo(() => {
    if (visibleNotifications.length === 0) return {};
    const dateFormatter = new Intl.DateTimeFormat("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    return visibleNotifications.reduce((groups, notification) => {
      const label = formatNotificationDate(notification.date, dateFormatter);
      if (!groups[label]) groups[label] = [];
      groups[label].push(notification);
      return groups;
    }, {});
  }, [visibleNotifications]);

  // Share a formatter for this render, not across wallets or time-zone changes.
  const timeFormatter = visibleNotifications.length === 0 ? null : new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

  const unreadCount = notifications.filter((notification) => notification.status === "unread").length;

  const markRead = (id) => {
    setReadIds((current) => {
      const next = new Set(current);
      next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-3 text-red-500">
            <Bell className="h-7 w-7" aria-hidden="true" />
            <h1 className="text-3xl font-bold text-vault-text">Vault Notifications</h1>
          </div>
          <p className="mt-2 max-w-2xl text-vault-muted">
            Review vault action updates, deposit confirmations, draw actions, and prize claims.
          </p>
        </div>
        <Link href="/app/activity" className="vq-btn-ghost self-start sm:self-auto">
          View activity
        </Link>
      </header>

      <div className="space-y-2">
        <p className="text-sm text-vault-muted">
          {wallet ? "Load notifications for your connected wallet. Your saved preferences filter this history." : "Connect a Stellar wallet to view its notifications."}
        </p>
        <button type="button" onClick={loadNotifications} disabled={!wallet || loading} className="vq-btn-primary disabled:opacity-60">
          {loading ? "Loading…" : loaded ? "Refresh notifications" : "Load notifications"}
        </button>
        {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
      </div>

      <section className="grid gap-4 sm:grid-cols-3" aria-label="Notification summary">
        <div className="vq-glass-hover p-5">
          <Inbox className="h-5 w-5 text-red-500" aria-hidden="true" />
          <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-vault-muted">Total notifications</p>
          <p className="mt-1 text-2xl font-bold text-vault-text">{notifications.length}</p>
        </div>
        <div className="vq-glass-hover p-5">
          <MailOpen className="h-5 w-5 text-amber-500" aria-hidden="true" />
          <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-vault-muted">Unread</p>
          <p className="mt-1 text-2xl font-bold text-vault-text">{unreadCount}</p>
        </div>
        <div className="vq-glass-hover p-5">
          <CheckCircle2 className="h-5 w-5 text-emerald-500" aria-hidden="true" />
          <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-vault-muted">Read</p>
          <p className="mt-1 text-2xl font-bold text-vault-text">{notifications.length - unreadCount}</p>
        </div>
      </section>

      <section className="vq-glass p-4 sm:p-6" aria-labelledby="notification-history-title">
        <div className="flex flex-col gap-4 border-b border-vault-border pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 id="notification-history-title" className="text-lg font-semibold text-vault-text">
              Notification History
            </h2>
            <p className="text-sm text-vault-muted">Grouped by date with current read status.</p>
          </div>
          <button
            type="button"
            onClick={() => setShowUnreadOnly((current) => !current)}
            className="vq-btn-ghost self-start sm:self-auto"
          >
            {showUnreadOnly ? "Show all" : "Unread only"}
          </button>
        </div>

        {visibleNotifications.length === 0 ? (
          <div className="flex flex-col items-center px-4 py-16 text-center">
            <CheckCircle2 className="h-10 w-10 text-vault-muted" aria-hidden="true" />
            <h3 className="mt-4 text-lg font-semibold text-vault-text">No notifications to show</h3>
            <p className="mt-2 max-w-md text-sm text-vault-muted">
              {loaded ? "No notifications match your saved preferences and current filter." : "Load notifications to see recorded activity for the connected wallet."}
            </p>
          </div>
        ) : (
          <div className="space-y-6 pt-5">
            {Object.entries(groupedNotifications).map(([dateLabel, items]) => (
              <div key={dateLabel}>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-vault-muted">{dateLabel}</h3>
                <ul className="mt-3 divide-y divide-vault-border rounded-xl border border-vault-border bg-vault-surface/30" role="list">
                  {items.map((notification) => {
                    const isRead = notification.status === "read";
                    return (
                      <li key={notification.id} className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between">
                        <div className="flex gap-3">
                          <span className={`mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-vault-border ${isRead ? "bg-vault-surface text-vault-muted" : "bg-red-500/10 text-red-500"}`}>
                            {isRead ? <Check className="h-4 w-4" aria-hidden="true" /> : <Bell className="h-4 w-4" aria-hidden="true" />}
                          </span>
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="font-semibold text-vault-text">{notification.title}</p>
                              <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${isRead ? "border-vault-border text-vault-muted" : "border-red-400/30 bg-red-500/10 text-red-500"}`}>
                                {isRead ? "Read" : "Unread"}
                              </span>
                            </div>
                            <p className="mt-1 text-sm text-vault-muted">{notification.message}</p>
                            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-vault-muted">
                              <span>{notification.type}</span>
                              <span aria-hidden="true">·</span>
                              <span className="inline-flex items-center gap-1">
                                <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                                {formatNotificationDate(notification.date, timeFormatter)}
                              </span>
                            </div>
                          </div>
                        </div>
                        {!isRead && (
                          <button
                            type="button"
                            onClick={() => markRead(notification.id)}
                            className="vq-btn-primary w-full sm:w-auto"
                          >
                            <Check className="h-4 w-4" aria-hidden="true" />
                            Mark read
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
