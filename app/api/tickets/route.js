import { chromium } from "playwright";
import csv from "csvtojson";
import dotenv from "dotenv";

dotenv.config();

// Helper: read download into Buffer
async function readDownload(download) {
  const stream = await download.createReadStream();
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

// Main scraping function
async function scrape(ticketType, startDateStr, endDateStr, radio) {
  const browser = await chromium.launch({ headless: true, args: ["--ignore-certificate-errors"] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  // LOGIN
  await page.goto(process.env.OSS_URL, { waitUntil: "networkidle" });
  await page.fill('input[placeholder="User ID"]', process.env.OSS_USERNAME);
  await page.fill('input[placeholder="Password"]', process.env.OSS_PASSWORD);
  await page.getByRole("button", { name: "OSS Login" }).click();

  await page.waitForSelector("text=Please select a job to log in");
  await page.getByText("CSD-Dunning-Orders-Handlers-Team(oss)", { exact: true }).dblclick();
  await page.waitForLoadState("networkidle");

  // Navigate to Trouble Ticket Monitoring
  await page.click(".js-menu");
  await page.waitForSelector(".nav-title");
  await page.getByText("Trouble Ticket Monitoring", { exact: true }).click();
  await page.waitForLoadState("networkidle");

  const moreButton = page.locator('button:has(span[role="img"][aria-label="more"])');
  await moreButton.waitFor();
  await moreButton.click();

  // Ticket Type Dropdown
  const label = page.locator("label", { hasText: "Ticket Type" });
  const dropdownId = await label.getAttribute("for");

  const dropdownSelector = page
    .locator(`#${dropdownId}`)
    .locator('xpath=ancestor::div[contains(@class,"ant-select")]/div[contains(@class,"ant-select-selector")]');

  await dropdownSelector.evaluate((el) => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

  await page.waitForSelector(".ant-select-item-option-content");
  await page.locator(".ant-select-item-option-content", { hasText: ticketType }).click();

  // Date Pickers
  const startDate = new Date(startDateStr);
  const endDate = new Date(endDateStr);
  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  async function setDate(inputSelector, targetDate) {
    await page.locator(inputSelector).nth(1).click({ force: true });
    const cal = page.locator(".ant-picker-dropdown:visible");
    await cal.waitFor();

    // YEAR
    while (true) {
      const y = Number(await cal.locator(".ant-picker-year-btn").textContent());
      if (y === targetDate.getFullYear()) break;
      if (y > targetDate.getFullYear())
        await cal.locator(".ant-picker-header-prev-btn").click();
      else await cal.locator(".ant-picker-header-next-btn").click();
    }

    // MONTH
    while (true) {
      const m = monthNames.indexOf(await cal.locator(".ant-picker-month-btn").textContent());
      if (m === targetDate.getMonth()) break;
      if (m > targetDate.getMonth())
        await cal.locator(".ant-picker-header-prev-btn").click();
      else await cal.locator(".ant-picker-header-next-btn").click();
    }

    // DATE
    await cal.locator(`td[title="${targetDate.toISOString().split("T")[0]}"]`).first().click();
    await cal.locator(".ant-picker-ok").first().click();
  }

  await setDate("#BEGIN_ACCEPT_TIME", startDate);
  await setDate("#END_ACCEPT_TIME", endDate);

  // RADIO BUTTON (supports Current, History, Both…)
  await page.locator('#HIS_FLAG label').filter({ hasText: new RegExp(`^${radio}$`, "i") }).click();

  // QUERY
  await page.locator('button.ant-btn.ant-btn-primary', { hasText: "Query" }).click();
  await page.locator('label[for="SP_ID"][title="Operator"]').click();

  // EXPORT CSV
  const exportButton = page.locator('span[role="img"][aria-label="export"]');
  await exportButton.waitFor();
  await exportButton.click();

  const csvButton = page.locator('li.ant-dropdown-menu-item:has-text("CSV")');
  await csvButton.waitFor();

  const [download] = await Promise.all([page.waitForEvent("download"), csvButton.click()]);

  const csvBuffer = await readDownload(download);
  const csvString = csvBuffer.toString("utf-8");

  await browser.close();

  return await csv().fromString(csvString);
}

// NEXT.JS API ROUTE
export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const ticketType = searchParams.get("ticketType");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    const radio = searchParams.get("radio");

    if (!ticketType || !startDate || !endDate || !radio) {
      return Response.json({ error: "Missing query parameters" }, { status: 400 });
    }

    const data = await scrape(ticketType, startDate, endDate, radio);
    return Response.json({ success: true, data });
  } catch (err) {
    console.error(err);
    return Response.json({ error: "Scraping failed", details: err.message }, { status: 500 });
  }
}
