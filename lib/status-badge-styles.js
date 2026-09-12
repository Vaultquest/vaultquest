/**
 * Complete, statically-written Tailwind class strings for each health/status
 * severity. Tailwind's build-time scanner reads source files as plain text —
 * it cannot resolve `bg-${color}-500`-style interpolation, so every class
 * combination a component might render must appear here as a literal string
 * (see https://tailwindcss.com/docs/detecting-classes-in-source-files).
 */
const STATUS_BADGE_STYLES = {
  operational: {
    badge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    iconAvatar: "bg-emerald-500/20 text-emerald-400 ring-2 ring-emerald-400/30",
    banner: "border-emerald-500/40 bg-emerald-500/10",
    solidIcon: "text-emerald-500",
  },
  degraded: {
    badge: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    iconAvatar: "bg-amber-500/20 text-amber-400 ring-2 ring-amber-400/30",
    banner: "border-amber-500/40 bg-amber-500/10",
    solidIcon: "text-amber-500",
  },
  outage: {
    badge: "bg-red-500/15 text-red-600 dark:text-red-400",
    iconAvatar: "bg-red-500/20 text-red-400 ring-2 ring-red-400/30",
    banner: "border-red-500/40 bg-red-500/10",
    solidIcon: "text-red-500",
  },
  /*
   * Neutral styling for the fourth state. Health rows with no trustworthy
   * probe report "unknown" (#115); without this entry they would fall back to
   * the operational green below and claim a health they cannot prove.
   */
  unknown: {
    badge: "bg-slate-500/15 text-slate-600 dark:text-slate-300",
    iconAvatar: "bg-slate-500/20 text-slate-400 ring-2 ring-slate-400/30",
    banner: "border-slate-500/40 bg-slate-500/10",
    solidIcon: "text-slate-500",
  },
};

/**
 * Returns the static class-string set for a status, falling back to
 * "operational" for unknown/transient values (e.g. a "loading" state).
 * O(1) object lookup; no string construction at runtime.
 * @param {string} status
 */
export function getStatusBadgeStyles(status) {
  return STATUS_BADGE_STYLES[status] ?? STATUS_BADGE_STYLES.operational;
}

export { STATUS_BADGE_STYLES };
