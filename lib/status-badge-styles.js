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
