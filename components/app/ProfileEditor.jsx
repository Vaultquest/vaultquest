"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useAccount } from "wagmi";
import { User, Save, Award, Sparkles, Check, AlertTriangle } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

// Simple blockie generator using wallet address as seed
const generateBlockie = (address, size = 8) => {
  if (!address) return [];

  const hash = address.toLowerCase().slice(2);
  const colors = [
    "#ef4444",
    "#f97316",
    "#f59e0b",
    "#eab308",
    "#84cc16",
    "#22c55e",
    "#10b981",
    "#14b8a6",
    "#06b6d4",
    "#0ea5e9",
    "#3b82f6",
    "#6366f1",
    "#8b5cf6",
    "#a855f7",
    "#d946ef",
  ];

  const grid = [];
  for (let i = 0; i < size * size; i++) {
    const charIndex = i % hash.length;
    const charCode = hash.charCodeAt(charIndex);
    const shouldFill = charCode % 2 === 0;
    const colorIndex = charCode % colors.length;
    grid.push(shouldFill ? colors[colorIndex] : "transparent");
  }

  return grid;
};

/**
 * Catalog of possible achievements. This list describes what *can* be earned;
 * it intentionally carries no unlocked flag. Whether an achievement is earned
 * is derived exclusively from the wallet's authoritative quest records returned
 * by the profile API - never from static UI data.
 */
const ACHIEVEMENT_CATALOG = [
  {
    id: "first_deposit",
    name: "First Steps",
    icon: "🚀",
    description: "Make your first deposit",
  },
  {
    id: "save_100",
    name: "Save $100",
    icon: "💰",
    description: "Accumulate $100 in confirmed deposits",
  },
  {
    id: "save_100_three_months",
    name: "Save $100 for 3 Months",
    icon: "📅",
    description: "Deposit in at least three distinct months",
  },
  {
    id: "participate_5_draws",
    name: "Participate in 5 Draws",
    icon: "🎯",
    description: "Deposit into at least five prize pools",
  },
  {
    id: "first_win",
    name: "Lucky Saver",
    icon: "🏆",
    description: "Claim a reward from a prize draw",
  },
];

const STORAGE_KEY_PREFIX = "vaultquest:profile:";

function readLocalProfile(address) {
  try {
    const raw = window.localStorage.getItem(`${STORAGE_KEY_PREFIX}${address.toLowerCase()}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeLocalProfile(address, profile) {
  try {
    window.localStorage.setItem(
      `${STORAGE_KEY_PREFIX}${address.toLowerCase()}`,
      JSON.stringify(profile),
    );
  } catch {
    // best effort
  }
}

export default function ProfileEditor() {
  const { address } = useAccount();
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [selectedBadge, setSelectedBadge] = useState(null);
  const [earnedBadgeIds, setEarnedBadgeIds] = useState(() => new Set());
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState("idle"); // idle | saved | error | conflict
  const [saveMessage, setSaveMessage] = useState("");
  const [degraded, setDegraded] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [showMobile, setShowMobile] = useState(false);

  const blockieGrid = useMemo(() => {
    return address ? generateBlockie(address) : [];
  }, [address]);

  const derivedAchievements = useMemo(() => {
    return ACHIEVEMENT_CATALOG.map((badge) => ({
      ...badge,
      unlocked: earnedBadgeIds.has(badge.id),
    }));
  }, [earnedBadgeIds]);

  const earnedBadges = useMemo(
    () => derivedAchievements.filter((b) => b.unlocked),
    [derivedAchievements],
  );

  const loadProfile = useCallback(
    async (wallet) => {
      setLoaded(false);
      const local = readLocalProfile(wallet);

      try {
        const res = await fetch(`/api/profile?wallet=${encodeURIComponent(wallet)}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const json = await res.json();
          const data = json.data || {};
          const achievements = Array.isArray(data.achievements) ? data.achievements : [];
          const earned = new Set(achievements.map((a) => a.questId));

          setDisplayName(data.display_name || local?.display_name || "");
          setBio(data.bio || local?.bio || "");
          setEarnedBadgeIds(earned);
          // Only a badge the wallet has actually earned can be displayed.
          const badge =
            data.badge_id && earned.has(data.badge_id) ? data.badge_id : null;
          setSelectedBadge(badge || local?.badge_id || null);
          setDegraded(json.degraded === true);
          setLoaded(true);
          return;
        }
      } catch {
        // backend unreachable - fall through to local profile
      }

      // Graceful fallback: surface locally persisted edits (same wallet/device)
      // but never fabricate achievements.
      setDisplayName(local?.display_name || "");
      setBio(local?.bio || "");
      setEarnedBadgeIds(new Set());
      setSelectedBadge(local?.badge_id || null);
      setDegraded(true);
      setLoaded(true);
    },
    [],
  );

  useEffect(() => {
    if (!address) return;
    loadProfile(address);
  }, [address, loadProfile]);

  const handleSave = async () => {
    if (!address) return;
    setSaving(true);
    setSaveState("idle");
    setSaveMessage("");

    const payload = {
      wallet_address: address,
      profile: {
        display_name: displayName.trim() || null,
        bio: bio.trim() || null,
        badge_id: selectedBadge,
      },
    };

    // Persist locally first so edits survive a reload even if the backend is
    // unreachable; the profile stays keyed by wallet.
    writeLocalProfile(address, {
      display_name: displayName.trim() || null,
      bio: bio.trim() || null,
      badge_id: selectedBadge,
    });

    try {
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const json = await res.json();
        const data = json.data || {};
        const achievements = Array.isArray(data.achievements) ? data.achievements : [];
        setEarnedBadgeIds(new Set(achievements.map((a) => a.questId)));
        setSaveState("saved");
        setSaveMessage("Profile saved");
      } else if (res.status === 409) {
        setSaveState("conflict");
        setSaveMessage("That display name is already taken by another account");
      } else if (res.status === 400) {
        const err = await res.json().catch(() => null);
        setSaveState("error");
        setSaveMessage(err?.error?.message || "Unable to save profile");
      } else {
        setSaveState("error");
        setSaveMessage("Unable to save profile right now");
      }
    } catch {
      setSaveState("saved");
      setSaveMessage("Profile saved locally");
    } finally {
      setSaving(false);
      setTimeout(() => {
        if (saveState === "saved") setSaveState("idle");
      }, 2000);
    }
  };

  const selectedBadgeCatalog = ACHIEVEMENT_CATALOG.find((b) => b.id === selectedBadge);
  const previewName = selectedBadgeCatalog?.name;

  if (!address) {
    return (
      <div className="vq-glass p-6 text-center">
        <User
          className="mx-auto h-12 w-12 text-vault-muted"
          aria-hidden="true"
        />
        <p className="mt-3 text-sm text-vault-muted">
          Connect your wallet to customize your profile
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Profile Card Preview */}
      <section className="vq-glass p-6">
        <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-vault-text">
          <User className="h-5 w-5 text-red-500" aria-hidden="true" />
          Profile Card Preview
        </h2>

        {degraded && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>
              Achievements are derived from verified quest records and are
              unavailable right now. Your profile edits are saved locally on this
              device until the backend is reachable.
            </span>
          </div>
        )}

        <div className="vq-glass-hover relative overflow-hidden p-6">
          {/* Background badge if selected */}
          {selectedBadgeCatalog && (
            <div className="absolute right-4 top-4 text-6xl opacity-10">
              {selectedBadgeCatalog.icon}
            </div>
          )}

          <div className="relative flex flex-col items-center gap-4 sm:flex-row">
            {/* Blockie Avatar */}
            <div className="relative">
              <div
                className="grid h-24 w-24 gap-0 overflow-hidden rounded-2xl border-4 border-vault-border shadow-glow"
                style={{
                  gridTemplateColumns: "repeat(8, 1fr)",
                  gridTemplateRows: "repeat(8, 1fr)",
                }}
              >
                {blockieGrid.map((color, i) => (
                  <div key={i} style={{ backgroundColor: color }} />
                ))}
              </div>
              {selectedBadgeCatalog && (
                <div className="absolute -bottom-2 -right-2 flex h-10 w-10 items-center justify-center rounded-full border-2 border-vault-bg bg-vault-surface text-2xl shadow-lg">
                  {selectedBadgeCatalog.icon}
                </div>
              )}
            </div>

            {/* Profile Info */}
            <div className="flex-1 text-center sm:text-left">
              <h3 className="text-xl font-bold text-vault-text">
                {displayName.trim() || `${address.slice(0, 6)}...${address.slice(-4)}`}
              </h3>
              {previewName && (
                <p className="mt-1 text-sm text-vault-muted">VaultQuest Saver</p>
              )}
              {selectedBadgeCatalog && (
                <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-red-500/15 px-3 py-1 text-xs font-medium text-red-600 dark:text-red-400">
                  <Award className="h-3 w-3" aria-hidden="true" />
                  {selectedBadgeCatalog.name}
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Editable Fields */}
      <section className="vq-glass p-6">
        <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-vault-text">
          <Sparkles className="h-5 w-5 text-red-500" aria-hidden="true" />
          Profile Details
        </h2>
        <div className="space-y-4">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-vault-text">
              Display name
            </span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={60}
              placeholder="How you appear on VaultQuest"
              className="w-full rounded-lg border border-vault-border bg-vault-surface/40 px-3 py-2 text-sm text-vault-text outline-none transition focus:border-red-400/60 focus:ring-2 focus:ring-red-400/20"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-vault-text">Bio</span>
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              maxLength={600}
              rows={3}
              placeholder="Tell savers a little about you"
              className="w-full resize-none rounded-lg border border-vault-border bg-vault-surface/40 px-3 py-2 text-sm text-vault-text outline-none transition focus:border-red-400/60 focus:ring-2 focus:ring-red-400/20"
            />
          </label>
        </div>
      </section>

      {/* Avatar Customization */}
      <section className="vq-glass p-6">
        <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-vault-text">
          <Sparkles className="h-5 w-5 text-red-500" aria-hidden="true" />
          Custom Avatar
        </h2>

        <div className="rounded-lg border border-vault-border bg-vault-surface/40 p-4">
          <p className="text-sm text-vault-muted">
            Your unique avatar is automatically generated from your wallet
            address using a blockie algorithm. Each address creates a distinct
            pattern that serves as your visual identity across VaultQuest.
          </p>
          <div className="mt-3 flex items-center gap-2 text-xs text-vault-muted">
            <Check className="h-4 w-4 text-emerald-500" aria-hidden="true" />
            High-resolution SVG format
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs text-vault-muted">
            <Check className="h-4 w-4 text-emerald-500" aria-hidden="true" />
            Deterministic generation (same address = same avatar)
          </div>
        </div>
      </section>

      {/* Achievement Badges */}
      <section className="vq-glass p-6">
        <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-vault-text">
          <Award className="h-5 w-5 text-red-500" aria-hidden="true" />
          Achievement Badges
        </h2>
        {!loaded && (
          <p className="text-sm text-vault-muted">Loading your achievements...</p>
        )}
        {loaded && earnedBadges.length === 0 && (
          <p className="text-sm text-vault-muted">
            Your achievements come from verified quest records and will appear
            here as you complete them.
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {derivedAchievements.map((badge) => (
            <button
              key={badge.id}
              type="button"
              disabled={!badge.unlocked}
              onClick={() =>
                setSelectedBadge(selectedBadge === badge.id ? null : badge.id)
              }
              className={`group relative overflow-hidden rounded-xl border p-4 text-left transition-all duration-300 ${
                !badge.unlocked
                  ? "cursor-not-allowed border-vault-border/30 bg-vault-surface/20 opacity-50"
                  : selectedBadge === badge.id
                    ? "border-red-400 bg-red-500/10 ring-2 ring-red-400/30"
                    : "border-vault-border bg-vault-surface/40 hover:border-red-400/40 hover:shadow-glow"
              }`}
            >
              <div className="flex items-start gap-3">
                <span className="text-3xl">{badge.icon}</span>
                <div className="flex-1">
                  <h3 className="text-sm font-semibold text-vault-text">
                    {badge.name}
                  </h3>
                  <p className="mt-1 text-xs text-vault-muted">
                    {badge.description}
                  </p>
                  {!badge.unlocked && (
                    <span className="mt-2 inline-block rounded-full bg-vault-border/30 px-2 py-0.5 text-xs font-medium text-vault-muted">
                      Locked
                    </span>
                  )}
                </div>
              </div>
              {selectedBadge === badge.id && (
                <div className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-red-500 text-white">
                  <Check className="h-4 w-4" aria-hidden="true" />
                </div>
              )}
            </button>
          ))}
        </div>
      </section>

      {/* Save status */}
      {saveState !== "idle" &&
        (saveState === "saved" ? (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
            <Check className="h-4 w-4" aria-hidden="true" />
            {saveMessage}
          </div>
        ) : saveState === "conflict" ? (
          <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            {saveMessage}
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            {saveMessage}
          </div>
        ))}

      {/* Save Button */}
      <div className="flex justify-end gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !loaded}
          className="vq-btn-primary disabled:opacity-60"
        >
          {saving ? (
            <>
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              Saving...
            </>
          ) : (
            <>
              <Save className="h-4 w-4" aria-hidden="true" />
              Save Profile
            </>
          )}
        </button>
      </div>

      {/* Mobile Layout Toggle (for demo) */}
      <button
        type="button"
        onClick={() => setShowMobile(!showMobile)}
        className="vq-btn-ghost w-full text-xs sm:hidden"
      >
        {showMobile ? "Hide" : "Show"} Mobile Preview
      </button>

      <AnimatePresence>
        {showMobile && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="vq-glass overflow-hidden p-4 sm:hidden"
          >
            <p className="mb-3 text-center text-xs font-medium text-vault-muted">
              Mobile Layout
            </p>
            <div className="mx-auto max-w-xs space-y-4">
              <div className="vq-glass-hover p-4">
                <div className="flex flex-col items-center gap-3">
                  <div
                    className="grid h-20 w-20 gap-0 overflow-hidden rounded-xl border-2 border-vault-border"
                    style={{
                      gridTemplateColumns: "repeat(8, 1fr)",
                      gridTemplateRows: "repeat(8, 1fr)",
                    }}
                  >
                    {blockieGrid.map((color, i) => (
                      <div key={i} style={{ backgroundColor: color }} />
                    ))}
                  </div>
                  <div className="text-center">
                    <p className="text-sm font-bold text-vault-text">
                      {displayName.trim() || `${address.slice(0, 6)}...${address.slice(-4)}`}
                    </p>
                    {selectedBadgeCatalog && (
                      <p className="mt-1 text-xs text-vault-muted">
                        {selectedBadgeCatalog.name}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
