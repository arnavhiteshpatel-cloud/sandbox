import type { Browser, BrowserContext, Page } from '@playwright/test';

export async function person(browser: Browser, name: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 } });
  await ctx.addInitScript((n) => { if (!localStorage.getItem('syncroom.name')) localStorage.setItem('syncroom.name', n); }, name);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
  return { ctx, page };
}

/** Start recording (wallclock, currentTime, playing) samples every 50 ms. */
export async function startSampling(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    w.__samples = [];
    clearInterval(w.__sampler);
    w.__sampler = setInterval(() => {
      const v = document.querySelector('video');
      if (v) w.__samples.push([performance.timeOrigin + performance.now(), v.currentTime, !v.paused && !v.seeking && v.readyState >= 3]);
    }, 50);
  });
}
export async function takeSamples(page: Page): Promise<[number, number, boolean][]> {
  return page.evaluate(() => { const w = window as any; clearInterval(w.__sampler); return w.__samples; });
}

/** Compare two position traces on a shared wall clock. Returns drift statistics in ms. */
export function driftStats(a: [number, number, boolean][], b: [number, number, boolean][], skipMs = 3000) {
  const start = Math.max(a[0][0], b[0][0]) + skipMs;
  const diffs: number[] = [];
  let j = 0;
  for (const [t, pa, playA] of a) {
    if (t < start || !playA) continue;
    while (j < b.length - 2 && b[j + 1][0] < t) j++;
    const [t0, p0, play0] = b[j], [t1, p1, play1] = b[j + 1];
    if (!play0 || !play1 || t < t0 || t > t1 || t1 - t0 > 200) continue;
    const pb = p0 + ((p1 - p0) * (t - t0)) / (t1 - t0);
    diffs.push(Math.abs(pa - pb) * 1000);
  }
  diffs.sort((x, y) => x - y);
  const q = (f: number) => diffs[Math.min(diffs.length - 1, Math.floor(diffs.length * f))] ?? NaN;
  return { n: diffs.length, median: q(0.5), p95: q(0.95), max: diffs[diffs.length - 1] ?? NaN, mean: diffs.reduce((s, x) => s + x, 0) / (diffs.length || 1) };
}

export const videoTime = (page: Page) => page.evaluate(() => document.querySelector('video')?.currentTime ?? -1);
export const videoPaused = (page: Page) => page.evaluate(() => document.querySelector('video')?.paused ?? true);
export const roomState = (page: Page) => page.evaluate(() => (window as any).__syncroom?.room?.state ?? null);
