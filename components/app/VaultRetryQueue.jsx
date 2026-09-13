"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  RefreshCw,
  Trash2,
  Wallet,
  XCircle,
  ShieldAlert,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { connectedPublicKey } from "@vaultquest/stellar-wallet-connect/src/core/store";
import { useAccount } from "wagmi";
import {
  cancelLedgerAction,
  checkActionLateConfirmation,
  fetchAuthoritativeQueueActions,
  getActionErrorMessage,
  isActionRetryable,
  saveLocalQueueActions,
} from "@/lib/actionRetryQueue";

function useNanostoreValue(store, fallback) {
  const [value, setValue] = useState(fallback);

  useEffect(() => {
    if (!store || typeof store.get !== "function") return;
    setValue(store.get());
    return store.subscribe(setValue);
  }, [store]);

  return value;
}

function StatusBadge({ status }) {
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2.5 py-0.5 text-xs font-medium text-red-600 dark:text-red-400">
        <AlertCircle className="h-3 w-3" aria-hidden="true" />
        Failed
      </span>
    );
  }
  if (status === "confirmed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
        Confirmed
      </span>
    );
  }
  if (status === "submitted") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2.5 py-0.5 text-xs font-medium text-blue-600 dark:text-blue-400">
        <RefreshCw className="h-3 w-3 animate-spin" aria-hidden="true" />
        Submitted
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
      <Clock className="h-3 w-3" aria-hidden="true" />
      Pending
    </span>
  );
}

function ActionIcon({ type }) {
  if (type === "deposit" || type === "join" || type === "drip") {
    return (
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-vault-border bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
        <Wallet className="h-5 w-5" aria-hidden="true" />
      </span>
    );
  }
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-vault-border bg-vault-surface text-vault-muted">
      <Wallet className="h-5 w-5" aria-hidden="true" />
    </span>
  );
}

function ErrorMessage({ errorCode, errorDetail }) {
  const message = getActionErrorMessage(errorCode, errorDetail);

  return (
    <p className="mt-1 text-xs text-red-500 dark:text-red-400">
      {message}
    </p>
  );
}

function formatTimeAgo(dateStr) {
  if (!dateStr) return "recently";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function QueuedAction({ action, isProcessing, onRetry, onCancel, onDismiss }) {
  const isPending = action.status === "pending" || action.status === "submitted";
  const retryable = isActionRetryable(action);

  return (
    <motion.li
      layout
      data-testid={`action-row-${action.id}`}
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0, marginBottom: 0 }}
      transition={{ duration: 0.2 }}
      className="flex items-start gap-4 rounded-xl border border-vault-border bg-vault-surface/50 p-4"
    >
      <ActionIcon type={action.type} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="font-medium capitalize text-vault-text">
            {action.type}
          </p>
          <StatusBadge status={action.status} />
          {action.retryCount > 0 && (
            <span className="text-xs text-vault-muted font-mono">
              Retry #{action.retryCount}
            </span>
          )}
          {!retryable && action.status === "failed" && (
            <span
              data-testid="non-retryable-badge"
              className="inline-flex items-center gap-1 rounded bg-vault-border px-1.5 py-0.5 text-[10px] text-vault-muted"
            >
              <ShieldAlert className="h-3 w-3" />
              Non-retryable
            </span>
          )}
        </div>
        <p className="mt-0.5 text-sm text-vault-muted">
          {action.pool} &middot; {action.amount} USDC
        </p>
        <p className="text-xs text-vault-muted">
          {formatTimeAgo(action.createdAt)}
        </p>
        {(action.errorCode || action.errorDetail) && (
          <ErrorMessage errorCode={action.errorCode} errorDetail={action.errorDetail} />
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {retryable && (
          <button
            type="button"
            onClick={() => onRetry(action)}
            disabled={isProcessing}
            className="vq-btn-primary px-3 py-1.5 text-xs transition-all disabled:opacity-50"
            aria-label={`Retry ${action.type}`}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${isProcessing ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            Retry
          </button>
        )}
        <button
          type="button"
          onClick={() => (isPending ? onCancel(action) : onDismiss(action))}
          disabled={isProcessing}
          className="vq-btn-ghost px-2 py-1.5 text-xs transition-all disabled:opacity-50"
          aria-label={isPending ? "Cancel pending action" : "Dismiss"}
        >
          {isPending ? (
            <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {isPending ? "Cancel" : "Dismiss"}
        </button>
      </div>
    </motion.li>
  );
}

export default function VaultRetryQueue({
  walletAddress: propWalletAddress,
  initialActions,
  onRetryAction,
  onCancelAction,
} = {}) {
  const stellarAddress = useNanostoreValue(connectedPublicKey, "");
  const { address: wagmiAddress } = useAccount();

  const activeWallet = propWalletAddress || stellarAddress || wagmiAddress || "";

  const [actions, setActions] = useState(() => initialActions || []);
  const [processingMap, setProcessingMap] = useState({});
  const [collapsed, setCollapsed] = useState(false);
  const [notification, setNotification] = useState(null);

  // Sync actions when active wallet changes or initialActions provided
  useEffect(() => {
    if (initialActions) {
      setActions(initialActions);
      return;
    }

    if (!activeWallet) {
      setActions([]);
      return;
    }

    let cancelled = false;
    fetchAuthoritativeQueueActions(activeWallet).then((loaded) => {
      if (!cancelled) {
        setActions(loaded);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [activeWallet, initialActions]);

  const failedCount = useMemo(
    () => actions.filter((a) => a.status === "failed").length,
    [actions]
  );
  const pendingCount = useMemo(
    () => actions.filter((a) => a.status === "pending" || a.status === "submitted").length,
    [actions]
  );
  const totalCount = actions.length;

  const handleRetry = useCallback(
    async (action) => {
      if (!action?.id) return;

      // Duplicate click prevention: check if already processing this action
      if (processingMap[action.id]) return;

      // Lock the action immediately
      setProcessingMap((prev) => ({ ...prev, [action.id]: true }));

      try {
        // Late confirmation check: verify against authoritative ledger first
        const latestOnChain = await checkActionLateConfirmation(action.id);
        if (latestOnChain && latestOnChain.status === "confirmed") {
          setActions((prev) =>
            prev.map((a) =>
              a.id === action.id ? { ...a, status: "confirmed", errorCode: null, errorDetail: null } : a
            )
          );
          setNotification({
            type: "success",
            message: `Action ${action.id} was already confirmed on-chain. Replay prevented.`,
          });
          return;
        }

        // Enforce retry policy: do not replay non-retryable actions
        if (!isActionRetryable(action)) {
          setNotification({
            type: "error",
            message: "This action cannot be replayed.",
          });
          return;
        }

        // Execute retry handler or fallback attempt
        if (onRetryAction) {
          const result = await onRetryAction(action);
          if (result) {
            setActions((prev) =>
              prev.map((a) => (a.id === action.id ? { ...a, ...result } : a))
            );
          }
        } else {
          // Stateful retry attempt: transition to pending with incremented retry count
          setActions((prev) =>
            prev.map((a) =>
              a.id === action.id
                ? {
                    ...a,
                    status: "pending",
                    errorCode: null,
                    errorDetail: null,
                    retryCount: (a.retryCount || 0) + 1,
                    updatedAt: new Date().toISOString(),
                  }
                : a
            )
          );
        }
      } catch (err) {
        // Capture failure in action record statefully
        const code = err?.code || "NETWORK_ERROR";
        const message = err?.message || "Retry attempt failed";
        setActions((prev) =>
          prev.map((a) =>
            a.id === action.id
              ? {
                  ...a,
                  status: "failed",
                  errorCode: code,
                  errorDetail: message,
                  retryCount: (a.retryCount || 0) + 1,
                  updatedAt: new Date().toISOString(),
                }
              : a
          )
        );
      } finally {
        setProcessingMap((prev) => ({ ...prev, [action.id]: false }));
      }
    },
    [onRetryAction, processingMap]
  );

  const handleCancel = useCallback(
    async (action) => {
      if (!action?.id) return;
      if (processingMap[action.id]) return;

      setProcessingMap((prev) => ({ ...prev, [action.id]: true }));

      try {
        if (onCancelAction) {
          await onCancelAction(action);
        } else {
          await cancelLedgerAction(action.id, activeWallet);
        }

        // Update statefully and idempotently: cancelled action is marked or removed
        setActions((prev) =>
          prev.map((a) =>
            a.id === action.id
              ? {
                  ...a,
                  status: "failed",
                  errorCode: "USER_CANCELLED",
                  errorDetail: "Action was cancelled by user",
                  updatedAt: new Date().toISOString(),
                }
              : a
          )
        );
      } catch (err) {
        console.warn("Cancellation failed:", err);
      } finally {
        setProcessingMap((prev) => ({ ...prev, [action.id]: false }));
      }
    },
    [activeWallet, onCancelAction, processingMap]
  );

  const handleDismiss = useCallback(
    (action) => {
      setActions((prev) => {
        const next = prev.filter((a) => a.id !== action.id);
        if (activeWallet) {
          saveLocalQueueActions(activeWallet, next);
        }
        return next;
      });
    },
    [activeWallet]
  );

  const handleClearAll = useCallback(() => {
    setActions([]);
    if (activeWallet) {
      saveLocalQueueActions(activeWallet, []);
    }
  }, [activeWallet]);

  // Hide the retry queue completely if there are no pending or failed actions
  if (totalCount === 0) return null;

  return (
    <section
      className="vq-glass p-4 sm:p-6 rounded-2xl border border-vault-border"
      role="region"
      aria-label="Transaction retry queue"
    >
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-2 text-left"
          aria-expanded={!collapsed}
          aria-controls="retry-queue-content"
        >
          <div className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-red-500" aria-hidden="true" />
            <h2 className="text-lg font-semibold text-vault-text">
              Pending Actions
            </h2>
          </div>
          <div className="flex gap-1.5">
            {failedCount > 0 && (
              <span className="inline-flex items-center rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-600 dark:text-red-400">
                {failedCount} failed
              </span>
            )}
            {pendingCount > 0 && (
              <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                {pendingCount} pending
              </span>
            )}
          </div>
        </button>

        <div className="flex items-center gap-2">
          {totalCount > 1 && (
            <button
              type="button"
              onClick={handleClearAll}
              className="vq-btn-ghost px-3 py-1.5 text-xs"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Clear all
            </button>
          )}
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="vq-btn-ghost px-3 py-1.5 text-xs"
            aria-label={collapsed ? "Expand queue" : "Collapse queue"}
          >
            {collapsed ? "Show" : "Hide"}
          </button>
        </div>
      </div>

      {notification && (
        <div
          role="alert"
          className={`mt-3 flex items-center gap-2 text-xs rounded-lg p-2.5 border ${
            notification.type === "success"
              ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
              : "text-rose-400 bg-rose-500/10 border-rose-500/20"
          }`}
        >
          {notification.type === "success" ? (
            <CheckCircle2 size={14} className="shrink-0" />
          ) : (
            <AlertCircle size={14} className="shrink-0" />
          )}
          <span>{notification.message}</span>
        </div>
      )}

      <AnimatePresence>
        {!collapsed && (
          <motion.div
            id="retry-queue-content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <p className="mt-2 text-sm text-vault-muted">
              {failedCount > 0
                ? `${failedCount} transaction${failedCount > 1 ? "s" : ""} failed. You can retry or dismiss them.`
                : `${pendingCount} transaction${pendingCount > 1 ? "s" : ""} waiting to be processed.`}
            </p>

            <ul className="mt-4 space-y-3" role="list">
              <AnimatePresence>
                {actions.map((action) => (
                  <QueuedAction
                    key={action.id}
                    action={action}
                    isProcessing={Boolean(processingMap[action.id])}
                    onRetry={handleRetry}
                    onCancel={handleCancel}
                    onDismiss={handleDismiss}
                  />
                ))}
              </AnimatePresence>
            </ul>

            {totalCount > 0 && (
              <div className="mt-4 flex items-center gap-2 rounded-lg bg-vault-surface/50 px-4 py-3 text-xs text-vault-muted">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden="true" />
                Successful retries will appear in your Activity page.
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
