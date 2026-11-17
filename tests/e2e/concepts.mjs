import { createRequire } from "node:module";
import { execSync } from "node:child_process";
const require = createRequire(execSync("npm root -g").toString().trim() + "/");
const { chromium } = require("playwright");
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1512, height: 945 }, deviceScaleFactor: 2 });
p.on("pageerror", (e) => console.log("ERR", e.message));
for (const n of process.argv.slice(2)) {
  await p.goto(`http://127.0.0.1:1420/design/concepts/${n}.html`);
  await p.waitForTimeout(1500);
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: `artifacts/shots/concept-${n}.png` });
}
await b.close();
