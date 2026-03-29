import type { RefreshResult } from "@mf-dashboard/db/types";
import { mfUrls } from "@mf-dashboard/meta/urls";
import type { Page } from "playwright";
import { debug, info, warn } from "../logger.js";

const DEFAULT_MAX_WAIT_MINUTES = 20;
const MAX_WAIT_TIME_MS =
  (Number(process.env.MAX_WAIT_MINUTES) || DEFAULT_MAX_WAIT_MINUTES) * 60 * 1000; // default: 20 minutes
const POLL_INTERVAL_MS = 30000; // 30 seconds

async function navigateToAccountsPage(page: Page): Promise<void> {
  await page.goto(mfUrls.accounts);
  await page.waitForLoadState("networkidle");
}

async function getUpdatingAccounts(page: Page): Promise<string[]> {
  const rows = page.locator("#account-table tr:has(td.account-status)");
  const count = await rows.count();
  const updatingAccounts: string[] = [];

  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const statusCells = row.locator("td.account-status");
    // Multiple td.account-status cells may exist in the same row (e.g., info_msg and normal)
    const allTexts = await statusCells.allTextContents();
    const statusText = allTexts.join(" ");

    // Only count as updating if it exactly matches "更新中"
    if (statusText?.trim() === "更新中") {
      const nameCell = row.locator("td.service a").first();
      const name = await nameCell.textContent();
      if (name) {
        updatingAccounts.push(name.trim());
      }
    }
  }

  return updatingAccounts;
}

export async function clickRefreshButton(page: Page): Promise<RefreshResult> {
  debug("Looking for refresh button...");

  // Navigate to home and click refresh button
  await page.goto(mfUrls.home);
  await page.waitForLoadState("networkidle");

  // 更新ボタンを探す（複数のセレクターを試行）
  const refreshButton = page
    .locator('a:has-text("更新"), button:has-text("更新"), input[value="更新"]')
    .first();
  try {
    await refreshButton.waitFor({ state: "visible", timeout: 5000 });
    await refreshButton.click();
  } catch {
    warn("Refresh button not found, skipping refresh");
    return { completed: true, incompleteAccounts: [] };
  }

  info("Refreshing accounts...");

  // Wait for refresh to start
  await page.waitForTimeout(3000);

  // Navigate to accounts page to check update status
  await navigateToAccountsPage(page);

  info("Waiting for all updates to complete on /accounts page...");

  const startTime = Date.now();

  while (Date.now() - startTime < MAX_WAIT_TIME_MS) {
    // Count accounts with "更新中" status (exclude cells that also have "正常" - hidden text)
    const statusCells = page.locator("#account-table td.account-status");
    const cellCount = await statusCells.count();
    let updatingCount = 0;

    for (let i = 0; i < cellCount; i++) {
      const text = await statusCells.nth(i).textContent();
      if (text?.trim() === "更新中") {
        updatingCount++;
      }
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    info(`[${elapsed}s] 残り: ${updatingCount}`);

    if (updatingCount === 0) {
      info("All updates completed!");
      return { completed: true, incompleteAccounts: [] };
    }

    // Wait and navigate to accounts page again to get fresh status
    // Using goto instead of reload to avoid ERR_ABORTED when frame is detached
    await page.waitForTimeout(POLL_INTERVAL_MS);
    try {
      await navigateToAccountsPage(page);
    } catch {
      await page.waitForTimeout(1000);
      await navigateToAccountsPage(page);
    }
  }

  // Timeout: get list of accounts still updating
  const incompleteAccounts = await getUpdatingAccounts(page);

  warn(`Max wait time exceeded. ${incompleteAccounts.length} accounts still updating:`);
  for (const account of incompleteAccounts) {
    warn(`  - ${account}`);
  }

  return { completed: false, incompleteAccounts };
}
