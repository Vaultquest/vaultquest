import { expect, test, type Page } from "@playwright/test";
import { getViolations, injectAxe } from "axe-playwright";
import { mockAppShell } from "./helpers/app-shell-mock";

async function expectNoSeriousViolations(page: Page) {
  await injectAxe(page);
  const violations = await getViolations(page);
  const blocking = violations.filter(
    ({ impact }) => impact === "serious" || impact === "critical",
  );

  expect(
    blocking.map(({ id, impact, help, nodes }) => ({
      id,
      impact,
      help,
      targets: nodes.map(({ target }) => target),
    })),
  ).toEqual([]);
}

async function openMockedPage(page: Page, path: string) {
  await mockAppShell(page);
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await page.locator("main").waitFor({ state: "visible" });
}

test.describe("financial-flow accessibility", () => {
  test("vault detail has no serious or critical violations", async ({ page }) => {
    await openMockedPage(page, "/app/vaults/1");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoSeriousViolations(page);
  });

  test("vault archive has no serious or critical violations", async ({ page }) => {
    await openMockedPage(page, "/app/vaults/archive");
    await expect(page.getByRole("heading", { name: "Round Archive" })).toBeVisible();
    await expectNoSeriousViolations(page);
  });

  test("wallet header and disconnected account state are accessible", async ({ page }) => {
    await openMockedPage(page, "/app/account");
    await expect(page.getByRole("heading", { name: "Wallet not connected" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();
    await expectNoSeriousViolations(page);
  });

  test("deposit dialog traps focus and restores it to the trigger", async ({ page }) => {
    await openMockedPage(page, "/app/vaults");
    const trigger = page.getByRole("button", { name: "Open deposit modal" });
    await trigger.focus();
    await trigger.press("Enter");

    const dialog = page.getByRole("dialog", { name: "Review gas before signing" });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("button", { name: "Close deposit modal" })).toBeFocused();
    await expectNoSeriousViolations(page);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("mobile navigation opens, closes, and exposes wallet controls", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openMockedPage(page, "/app/vaults");

    const menu = page.getByRole("button", { name: "Toggle menu" });
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("navigation", { name: "Mobile" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();
    await expectNoSeriousViolations(page);

    await page.getByRole("link", { name: "Vaults" }).last().click();
    await expect(menu).toHaveAttribute("aria-expanded", "false");
  });
});
