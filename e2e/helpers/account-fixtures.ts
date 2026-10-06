import { type Page } from "@playwright/test";

/**
 * Enable account-page URL fixtures (`mockConnected`, `networkMismatch`) for
 * Playwright. Production builds ignore those query params unless this flag
 * (or NEXT_PUBLIC_ALLOW_ACCOUNT_TEST_FIXTURES) is present.
 */
export async function enableAccountTestFixtures(page: Page) {
  await page.addInitScript(() => {
    (window as any).__VQ_ALLOW_ACCOUNT_TEST_FIXTURES__ = true;
  });
}
