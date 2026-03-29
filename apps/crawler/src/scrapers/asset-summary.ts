import type { AssetSummary } from "@mf-dashboard/db/types";
import { mfUrls } from "@mf-dashboard/meta/urls";
import type { Page } from "playwright";
import { debug } from "../logger.js";

export async function getAssetSummary(page: Page): Promise<AssetSummary> {
  debug("Getting asset summary from top page...");

  await page.goto(mfUrls.home, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  // 資産表示エリアが表示されるまで待機（見つからない場合も続行）
  try {
    await page
      .locator(".heading-radius-box, .total-assets, .bs-total-asset")
      .first()
      .waitFor({ state: "visible", timeout: 10000 });
  } catch {
    debug("Asset summary area not found, continuing with defaults");
  }

  // Get total assets - try multiple selectors
  let totalAssets = "取得失敗";
  try {
    // Primary: .heading-radius-box (more reliable, contains just the amount)
    const headingBox = await page
      .locator(".heading-radius-box")
      .first()
      .textContent({ timeout: 5000 });
    if (headingBox) {
      const match = headingBox.match(/[\d,]+円/);
      if (match) {
        totalAssets = match[0];
      }
    }
  } catch {
    // Fallback: .total-assets
    try {
      const totalAssetsText = await page.locator(".total-assets").textContent({ timeout: 5000 });
      const match = totalAssetsText?.match(/[\d,]+円/);
      totalAssets = match ? match[0] : "取得失敗";
    } catch {
      debug("Total assets selector failed");
    }
  }

  // Get monthly change from .pfm-sheet-table
  // Table rows: 今週 | -0.0% | -14,764円 / 今月 | +2.2% | +2,140,505円 / 今年 | +2.2% | +2,140,505円
  let monthlyChange = "取得失敗";
  let monthlyChangePercent = "";
  try {
    const changeTable = page.locator("table.pfm-sheet-table").first();
    const monthRow = changeTable.locator("tbody tr").nth(1); // 今月 row
    const cells = monthRow.locator("td");
    monthlyChangePercent = (await cells.nth(0).textContent({ timeout: 3000 })) || "";
    monthlyChange = (await cells.nth(1).textContent({ timeout: 3000 })) || "取得失敗";
  } catch {
    debug("Monthly change selector failed");
  }

  // dailyChange will be calculated from asset items in slack.ts
  return {
    totalAssets: totalAssets.trim(),
    dailyChange: "",
    dailyChangePercent: "",
    monthlyChange: monthlyChange.trim(),
    monthlyChangePercent: monthlyChangePercent.trim(),
  };
}
