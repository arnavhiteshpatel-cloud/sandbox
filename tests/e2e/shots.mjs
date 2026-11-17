// Usage: node tests/e2e/shots.mjs <url> <outdir> — renders layout concepts with demo data.
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
const require = createRequire(execSync("npm root -g").toString().trim() + "/");
const { chromium } = require("playwright");
const [url = "http://127.0.0.1:1420", out = "artifacts/shots"] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1512, height: 945 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
page.on("console", (m) => m.type() === "error" && console.log("CONSOLE", m.text()));
await page.goto(url);
await page.waitForSelector('[data-testid="app"]', { timeout: 30000 });
console.log(await page.evaluate(() => window.__faceletDemo()));
await page.waitForFunction(() => document.querySelector('[data-testid="scramble"]')?.textContent?.includes(" ") && !document.querySelector('[data-testid="scramble"]').textContent.includes("generating"), null, { timeout: 60000 });
await page.waitForTimeout(800);
const themes = (process.env.THEMES || "hud").split(",");
for (const t of themes) {
  await page.evaluate((t) => window.__faceletStore.getState().updateSettings({ theme: t }), t);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/app-${t}.png` });
}
await browser.close();
