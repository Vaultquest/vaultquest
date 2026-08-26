import { describe, it, expect } from "vitest";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { STATUS_BADGE_STYLES } from "@/lib/status-badge-styles";
import projectTailwindConfig from "../tailwind.config.js";

/**
 * Production-build regression for VaultHealthStatusPanel / SystemStatusBanner
 * severity styling (issue: Tailwind cannot discover interpolated class names
 * like `bg-${color}-500`, so operational/degraded/outage styles could be
 * silently dropped from optimized CSS).
 *
 * This runs the real Tailwind/PostCSS production pipeline — the same engine
 * `pnpm build` uses — and asserts every severity's utility classes are
 * actually emitted, rather than screenshotting a runtime-dependent (random /
 * network-driven) UI state.
 */

const COMPONENT_FILES = [
  path.resolve(__dirname, "../components/app/VaultHealthStatusPanel.jsx"),
  path.resolve(__dirname, "../components/app/SystemStatusBanner.jsx"),
];
const STYLES_SOURCE_FILE = path.resolve(__dirname, "status-badge-styles.js");

function escapeForSelector(className) {
  return className.replace(/[:/]/g, (char) => `\\${char}`);
}

function allUtilityClasses() {
  const classes = new Set();
  for (const groups of Object.values(STATUS_BADGE_STYLES)) {
    for (const classString of Object.values(groups)) {
      for (const token of classString.split(/\s+/)) {
        classes.add(token);
      }
    }
  }
  return [...classes];
}

async function buildCss(content) {
  const result = await postcss([tailwindcss({ darkMode: "class", content })]).process(
    "@tailwind utilities;",
    { from: undefined }
  );
  return result.css;
}

describe("severity styling survives the production Tailwind build", () => {
  const expectedClasses = allUtilityClasses();

  it("emits every operational/degraded/outage utility class when scanning only the fix's own files", async () => {
    const css = await buildCss([...COMPONENT_FILES, STYLES_SOURCE_FILE]);

    expect(css.length).toBeGreaterThan(0);
    for (const className of expectedClasses) {
      const selector = `.${escapeForSelector(className)}`;
      expect(css.includes(selector), `expected optimized CSS to contain ${selector}`).toBe(true);
    }
  });

  it("keeps lib/ registered in the project's real content globs", () => {
    const scansLib = projectTailwindConfig.content.some((glob) => glob.includes("./lib/"));
    expect(
      scansLib,
      "tailwind.config.js must scan lib/ or getStatusBadgeStyles' static classes will be dropped from production CSS again"
    ).toBe(true);
  });

  it("produces the same severity classes through the project's real tailwind.config.js", async () => {
    const css = await buildCss(projectTailwindConfig.content);

    for (const className of expectedClasses) {
      const selector = `.${escapeForSelector(className)}`;
      expect(css.includes(selector), `expected optimized CSS to contain ${selector}`).toBe(true);
    }
  });
});
