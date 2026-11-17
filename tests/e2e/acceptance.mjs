// End-to-end acceptance tests driving the real UI in Chromium (browser backend = IndexedDB).
// Usage: node tests/e2e/acceptance.mjs [url]   (expects the Vite dev server)
// Writes artifacts/acceptance/report.json and screenshots.
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const require = createRequire(execSync("npm root -g").toString().trim() + "/");
const { chromium } = require("playwright");

const URL = process.argv[2] || "http://127.0.0.1:1420";
const OUT = "artifacts/acceptance";
mkdirSync(OUT, { recursive: true });
mkdirSync("artifacts/tmp", { recursive: true });
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1512, height: 945 }, acceptDownloads: true });
// Offline guarantee: any request that is not to the local dev server fails the test.
const external = [];
await ctx.route("**/*", (route) => {
  const u = route.request().url();
  if (u.startsWith(URL) || u.startsWith("data:") || u.startsWith("blob:")) return route.continue();
  external.push(u);
  return route.abort();
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept(d.defaultValue() || undefined));

const solveCount = () => page.evaluate(() => window.__faceletStore.getState().solves.filter((s) => !s.deletedAt).length);
const shot = (n) => page.screenshot({ path: join(OUT, n + ".png") });

// 1. launch
let t0 = Date.now();
await page.goto(URL);
await page.waitForSelector('[data-testid="app"]', { timeout: 30000 });
check("1. application launches", true, `${Date.now() - t0} ms to interactive`);
await page.waitForFunction(() => { const t = document.querySelector('[data-testid="scramble"]')?.textContent || ""; return t.trim().split(/\s+/).length >= 15; }, null, { timeout: 60000 });
const scr1 = (await page.textContent('[data-testid="scramble"]')).trim();
check("3a. random-state 3x3 scramble generated offline", scr1.split(/\s+/).length >= 15, scr1);

// 3. time a real solve with WCA inspection (keyboard)
const before = await solveCount();
await page.keyboard.down("Space"); await page.keyboard.up("Space");
await page.waitForTimeout(1200);
const insp = await page.getAttribute('[data-testid="timer"]', "data-phase");
await page.keyboard.down("Space"); await page.waitForTimeout(450);
const ready = await page.getAttribute('[data-testid="timer"]', "data-phase");
await page.keyboard.up("Space");
const running = await page.getAttribute('[data-testid="timer"]', "data-phase");
const hidden = await page.evaluate(() => document.querySelector(".app").classList.contains("timing"));
const runText = (await page.textContent('[data-testid="timer"]')).trim();
await page.waitForTimeout(1500);
await page.keyboard.down("KeyJ"); await page.keyboard.up("KeyJ");
await page.waitForTimeout(300);
const after = await solveCount();
const last = await page.evaluate(() => { const st = window.__faceletStore.getState(); const l = st.solves.filter((s) => s.sessionId === st.currentSessionId && !s.deletedAt).sort((a, b) => a.ord - b.ord).at(-1); return l; });
check("3b. inspection → hold (green) → run → stop records a solve", insp === "inspect" && ready === "ready" && running === "run" && after === before + 1, `phases ${insp}/${ready}/${running}; time ${last?.time} ms`);
check("3c. solve timed accurately from key events (≈1.5 s)", last && last.time > 1400 && last.time < 1700, `${last?.time} ms`);
check("3d. time hidden while solving, UI chrome hidden", runText.toLowerCase() === "solving" && hidden, `display "${runText}"`);
check("3e. scramble saved with solve and next scramble shown", last?.scramble === scr1 && (await page.textContent('[data-testid="scramble"]')).trim() !== scr1);

// 4. persistence after restart
await page.reload();
await page.waitForSelector('[data-testid="app"]');
await page.waitForTimeout(500);
check("4. solves persist after restart", (await solveCount()) === after, `${await solveCount()} solves`);

// 7. penalties & rolling averages via typing mode in a fresh session
await page.evaluate(() => { const st = window.__faceletStore.getState(); st.createSession({ name: "Acceptance", event: "333" }); st.updateSettings({ inputMode: "typing" }); });
await page.waitForSelector('[data-testid="typing-input"]');
for (const t of ["1000", "1100", "1200", "1300", "1400"]) { await page.fill('[data-testid="typing-input"]', t); await page.keyboard.press("Enter"); await page.waitForTimeout(80); }
const ao5a = (await page.textContent('[data-testid="cur-ao5"]')).trim();
await page.evaluate(() => { const st = window.__faceletStore.getState(); const l = st.solves.filter((s) => s.sessionId === st.currentSessionId && !s.deletedAt).sort((a, b) => a.ord - b.ord); st.updateSolves([l[0].id], () => ({ penalty: -1 }), "t"); });
await page.waitForTimeout(150);
const ao5b = (await page.textContent('[data-testid="cur-ao5"]')).trim();
await page.evaluate(() => { const st = window.__faceletStore.getState(); const l = st.solves.filter((s) => s.sessionId === st.currentSessionId && !s.deletedAt).sort((a, b) => a.ord - b.ord); st.updateSolves([l[1].id], () => ({ penalty: 2000 }), "t"); });
await page.waitForTimeout(150);
const ao5c = (await page.textContent('[data-testid="cur-ao5"]')).trim();
await page.evaluate(() => { const st = window.__faceletStore.getState(); const l = st.solves.filter((s) => s.sessionId === st.currentSessionId && !s.deletedAt).sort((a, b) => a.ord - b.ord); st.updateSolves([l[2].id], () => ({ penalty: -1 }), "t"); });
await page.waitForTimeout(150);
const ao5d = (await page.textContent('[data-testid="cur-ao5"]')).trim();
const mo3 = (await page.textContent('[data-testid="cur-mo3"]')).trim();
check("7a. ao5 of 10,11,12,13,14 = 12.00", ao5a === "12.00", ao5a);
check("7b. one DNF is trimmed: DNF,11,12,13,14 → 13.00", ao5b === "13.00", ao5b);
check("7c. +2 applied: DNF,13+,12,13,14 → 13.33", ao5c === "13.33", ao5c);
check("7d. two DNFs → ao5 DNF; mo3 with DNF → DNF", ao5d === "DNF" && mo3 === "DNF", `${ao5d} / ${mo3}`);
await page.evaluate(() => window.__faceletStore.getState().updateSettings({ inputMode: "timer" }));
await page.waitForTimeout(200);
await page.keyboard.press("Meta+z"); await page.waitForTimeout(150);
check("7e. undo restores previous penalty", (await page.textContent('[data-testid="cur-ao5"]')).trim() === "13.33");
await page.evaluate(() => window.__faceletStore.getState().updateSettings({ inputMode: "timer" }));

// 5. import csTimer backup through the UI (file chooser)
const fixture = execSync(`node -e "${"import('./src/core/testdata.ts').catch(()=>0)"}" 2>/dev/null || true`).toString();
void fixture;
const backupText = await page.evaluate(async () => { const m = await import("/src/core/testdata.ts"); return JSON.stringify(m.makeCsTimerBackup()); });
const fixturePath = "artifacts/tmp/cstimer_fixture.txt";
writeFileSync(fixturePath, backupText);
const src = JSON.parse(backupText);
const srcCount = Object.keys(src).filter((k) => /^session\d+$/.test(k)).reduce((n, k) => n + (typeof src[k] === "string" ? JSON.parse(src[k]) : src[k]).length, 0);
await page.evaluate(() => window.__faceletStore.getState().setView("settings"));
await page.click("text=Data");
await page.click('[data-testid="open-import"]');
const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click('[data-testid="import-pick"]')]);
t0 = Date.now();
await chooser.setFiles(fixturePath);
await page.waitForSelector('[data-testid="preview-total"]', { timeout: 60000 });
const previewTotal = (await page.textContent('[data-testid="preview-total"]')).replace(/,/g, "");
check("5a. import preview shows every solve before writing", +previewTotal === srcCount, `${previewTotal} of ${srcCount} (parse+plan ${Date.now() - t0} ms)`);
await shot("import-preview");
const beforeImport = await solveCount();
t0 = Date.now();
await page.click('[data-testid="import-commit"]');
await page.waitForSelector('[data-testid="verify-result"]', { timeout: 120000 });
const verify = await page.textContent('[data-testid="verify-result"]');
await shot("import-report");
const afterImport = await solveCount();
check("5b. all historical solves imported and verified", afterImport - beforeImport === srcCount && verify.includes("Passed"), `${afterImport - beforeImport} added in ${Date.now() - t0} ms; "${verify}"`);
const sameData = await page.evaluate(async (text) => {
  const src = JSON.parse(text);
  const st = window.__faceletStore.getState();
  const out = [];
  for (const k of Object.keys(src).filter((k) => /^session\d+$/.test(k))) {
    const arr = typeof src[k] === "string" ? JSON.parse(src[k]) : src[k];
    const name = JSON.parse(src.properties.sessionData)[k.slice(7)].name;
    const ses = st.sessions.find((s) => s.name === String(name) && s.sourceKey === "cstimer:" + k);
    const list = st.solves.filter((s) => s.sessionId === ses.id && !s.deletedAt).sort((a, b) => a.ord - b.ord);
    let mism = 0;
    arr.forEach((e, i) => {
      const s = list[i];
      if (!s || s.time !== e[0][1] || s.penalty !== e[0][0] || s.scramble !== e[1] || s.comment !== e[2] || (s.date ?? 0) !== (e[3] ? e[3] * 1000 : 0)) mism++;
    });
    out.push({ name, n: arr.length, stored: list.length, mism });
  }
  return out;
}, backupText);
check("5c. times, penalties, scrambles, comments, dates and order match the source exactly", sameData.every((x) => x.mism === 0 && x.n === x.stored), JSON.stringify(sameData));
await page.click('[data-testid="import-done"]');

// 6. re-import → no duplicates
await page.click('[data-testid="open-import"]');
const [chooser2] = await Promise.all([page.waitForEvent("filechooser"), page.click('[data-testid="import-pick"]')]);
await chooser2.setFiles(fixturePath);
await page.waitForSelector('[data-testid="import-commit"]');
const btn = await page.textContent('[data-testid="import-commit"]');
const disabled = await page.isDisabled('[data-testid="import-commit"]');
check("6. repeated import creates no duplicates", disabled && /Import 0 /.test(btn), btn.trim());
await page.keyboard.press("Escape");

// 8. large dataset: search + analytics + history responsiveness
await page.evaluate(() => window.__faceletStore.getState().setView("history"));
await page.waitForSelector('[data-testid="history-list"]');
await page.selectOption('[data-testid="history-scope"]', "*");
t0 = Date.now();
await page.fill('[data-testid="history-search"]', "lucky");
await page.waitForTimeout(50);
const searchMs = Date.now() - t0;
const rows = await page.$$eval('[data-testid="history-row"]', (r) => r.length);
check("8a. search across 20k+ solves is fast", searchMs < 1000 && rows > 0, `${searchMs} ms, ${rows} rows rendered`);
await shot("history");
t0 = Date.now();
await page.evaluate(() => window.__faceletStore.getState().setView("timer"));
await page.waitForSelector('[data-testid="stats-table"]');
check("8b. timer with ~19k-solve session stats renders quickly", Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
await page.waitForTimeout(1500);
await shot("timer-imported");

// 10. backup & restore, export
await page.evaluate(() => window.__faceletStore.getState().setView("settings"));
await page.click("text=Data");
await page.click('[data-testid="backup-now"]');
await page.waitForTimeout(1500);
const nBefore = await solveCount();
await page.evaluate(() => { const st = window.__faceletStore.getState(); st.deleteSolves(st.solves.filter((s) => !s.deletedAt).slice(0, 500).map((s) => s.id)); });
await page.waitForTimeout(500);
const nDeleted = await solveCount();
const blist = await page.evaluate(() => window.__faceletStore.getState().backend.backupList());
console.log("backups:", blist.slice(0, 3).map((b) => b.reason + "@" + b.createdAt).join(", "));
await page.click('[data-testid="backup-restore"] >> nth=0');
await page.waitForTimeout(4000);
const nRestored = await solveCount();
check("10a. backup restore brings data back", nDeleted === nBefore - 500 && nRestored === nBefore, `${nBefore} → ${nDeleted} → ${nRestored}`);
const [dl] = await Promise.all([page.waitForEvent("download"), page.click('[data-testid="export-cstimer"]')]);
const p = join("artifacts/tmp", "export.txt");
await dl.saveAs(p);
const exp = JSON.parse(readFileSync(p, "utf8"));
const expCount = Object.keys(exp).filter((k) => /^session\d+$/.test(k)).reduce((n, k) => n + exp[k].length, 0);
check("10b. full export to csTimer format contains every solve", expCount === nRestored, `${expCount} exported`);

// 2/9. visual + fullscreen-style timing check, then offline
await page.evaluate(() => window.__faceletStore.getState().setView("timer"));
await page.waitForTimeout(800);
await shot("timer");
check("11/12. no network access outside the app (offline)", external.length === 0, external.slice(0, 3).join(", "));
check("no uncaught page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

writeFileSync(join(OUT, "report.json"), JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
await browser.close();
process.exit(failed ? 1 : 0);
