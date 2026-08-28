import { describe, it, expect } from "vitest";
import { STATUS_BADGE_STYLES, getStatusBadgeStyles } from "@/lib/status-badge-styles";

const STATUSES = ["operational", "degraded", "outage"];
const STYLE_GROUPS = ["badge", "iconAvatar", "banner", "solidIcon"];

describe("status-badge-styles", () => {
  it("defines every style group as a complete, non-interpolated static string for each status", () => {
    for (const status of STATUSES) {
      for (const group of STYLE_GROUPS) {
        const value = STATUS_BADGE_STYLES[status][group];
        expect(typeof value).toBe("string");
        expect(value.length).toBeGreaterThan(0);
        // Guards against regressing into `bg-${color}-500`-style interpolation,
        // which Tailwind's build-time scanner cannot resolve.
        expect(value).not.toMatch(/\$\{|undefined|null/);
      }
    }
  });

  it("pairs every light-mode text class with its dark-mode variant in badges", () => {
    for (const status of STATUSES) {
      const { badge } = STATUS_BADGE_STYLES[status];
      expect(badge).toMatch(/(?:^|\s)text-\w+-600(?:\s|$)/);
      expect(badge).toMatch(/(?:^|\s)dark:text-\w+-400(?:\s|$)/);
    }
  });

  it("maps each status to its expected color family", () => {
    expect(getStatusBadgeStyles("operational").solidIcon).toBe("text-emerald-500");
    expect(getStatusBadgeStyles("degraded").solidIcon).toBe("text-amber-500");
    expect(getStatusBadgeStyles("outage").solidIcon).toBe("text-red-500");
  });

  it("falls back to the operational styles for unknown or transient statuses", () => {
    expect(getStatusBadgeStyles("loading")).toEqual(STATUS_BADGE_STYLES.operational);
    expect(getStatusBadgeStyles(undefined)).toEqual(STATUS_BADGE_STYLES.operational);
  });
});
