import { createRequire } from "node:module";
import { execSync } from "node:child_process";
const require = createRequire(execSync("npm root -g").toString().trim() + "/");
const { chromium } = require("playwright");
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1512, height: 945 } });
const errs = []; p.on("pageerror", (e) => errs.push(e.message));
await p.goto("http://127.0.0.1:1420");
await p.waitForSelector('[data-testid="app"]');
await p.evaluate(() => window.__faceletDemo());
const set = (o) => p.evaluate((o) => window.__faceletStore.getState().updateSettings(o), o);
await p.evaluate(() => window.__faceletStore.getState().setView("settings"));
await p.waitForTimeout(1200);
await p.screenshot({ path: "artifacts/shots/looks-settings.png", fullPage: false });
await p.evaluate(() => document.querySelector(".page").scrollTo(0, 560));
await p.waitForTimeout(400);
await p.screenshot({ path: "artifacts/shots/looks-backgrounds.png" });
await p.evaluate(() => window.__faceletStore.getState().setView("timer"));
for (const [theme, bg] of [["nebula", "starfield"], ["ember", "aurora"], ["gold", "constellation"], ["matrix", "grid"]]) {
  await set({ theme, background: bg });
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `artifacts/shots/looks-${theme}-${bg}.png` });
}
console.log("errors", errs);
await b.close();
