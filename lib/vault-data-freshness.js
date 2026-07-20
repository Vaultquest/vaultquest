export const VAULT_DATA_STALE_AFTER_MS = 2 * 60 * 1000;
export const VAULT_DATA_UNAVAILABLE_AFTER_MS = 10 * 60 * 1000;

export function classifyVaultData({
  updatedAt,
  degraded = false,
  hasData = true,
  error = null,
  now = Date.now(),
}) {
  if (!hasData) {
    return { status: "unavailable", ageMs: null, updatedAt: null };
  }

  const timestamp = Date.parse(updatedAt || "");
  if (!Number.isFinite(timestamp)) {
    return { status: "degraded", ageMs: null, updatedAt: null };
  }

  const ageMs = Math.max(0, now - timestamp);
  if (error || ageMs >= VAULT_DATA_UNAVAILABLE_AFTER_MS) {
    return { status: "unavailable", ageMs, updatedAt: new Date(timestamp) };
  }
  if (degraded) {
    return { status: "degraded", ageMs, updatedAt: new Date(timestamp) };
  }
  if (ageMs >= VAULT_DATA_STALE_AFTER_MS) {
    return { status: "stale", ageMs, updatedAt: new Date(timestamp) };
  }
  return { status: "fresh", ageMs, updatedAt: new Date(timestamp) };
}

export function formatVaultDataAge(updatedAt, now = Date.now()) {
  if (!updatedAt) return "Update time unavailable";
  const ageSeconds = Math.max(0, Math.floor((now - updatedAt.getTime()) / 1000));
  if (ageSeconds < 60) return "Updated just now";
  if (ageSeconds < 3600) return `Updated ${Math.floor(ageSeconds / 60)}m ago`;
  return `Updated ${Math.floor(ageSeconds / 3600)}h ago`;
}
