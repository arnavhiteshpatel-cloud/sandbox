import { createRequire } from "node:module";
import { execSync } from "node:child_process";
const require = createRequire(execSync("npm root -g").toString().trim() + "/");
const { chromium } = require("playwright");
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1512, height: 945 } });
await p.goto("http://127.0.0.1:1420");
await p.waitForSelector('[data-testid="app"]');
await p.evaluate(() => window.__faceletDemo());
for (const v of (process.argv[2] || "sessions,settings").split(",")) {
  await p.evaluate((v) => window.__faceletStore.getState().setView(v), v);
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `artifacts/shots/page-${v}.png` });
}
await b.close();
