import { devices, expect, test } from '@playwright/test';
import { person, videoPaused, videoTime } from './helpers';

test.describe('catalogue & discovery', () => {
  test('home shows real catalogue shelves', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('hero')).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => page.getByTestId('row').count(), { timeout: 60_000 }).toBeGreaterThan(6);
    expect(await page.getByTestId('poster-card').count()).toBeGreaterThan(150);
    await expect(page.getByText('Trending Movies')).toBeVisible();
    // a fresh install seeds the verified index in the background; give it time, then reload
    await expect.poll(async () => { await page.reload({ waitUntil: 'networkidle' }); return page.getByRole('heading', { name: 'Watch Free Now' }).count(); }, { timeout: 150_000, intervals: [10_000] }).toBe(1);
  });

  test('autocomplete and filtered search return real titles', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('search-input').fill('3 idiots');
    await expect(page.getByTestId('suggestion').first()).toContainText('3 Idiots', { timeout: 30_000 });
    await page.getByTestId('search-input').fill('breaking bad');
    await expect(page.getByTestId('suggestion').first()).toContainText('Breaking Bad');
    await page.getByTestId('search-input').press('Enter');
    await expect(page).toHaveURL(/\/search\?q=breaking/);
    await expect(page.getByTestId('poster-card').first()).toBeVisible();
    await page.request.get('/api/sources/movie/tt0063350'); // make sure it has been verified at least once
    await page.goto('/search?q=night%20of%20the%20living%20dead&playable=1');
    await expect(page.getByTestId('poster-card').first()).toContainText('Night of the Living Dead', { timeout: 60_000 });
    await expect(page.getByTestId('poster-card').first()).toContainText('WATCH');
  });

  test('movie detail: metadata, cast, verified sources', async ({ page }) => {
    await page.goto('/title/movie/tt0063350');
    await expect(page.getByTestId('title-page')).toContainText('1968');
    await expect(page.getByText('George A. Romero').first()).toBeVisible();
    await expect(page.getByTestId('source-row').first()).toBeVisible({ timeout: 90_000 });
    await expect(page.getByTestId('source-row').first()).toContainText('Verified');
    await expect(page.getByTestId('watch-btn')).toBeVisible();
  });

  test('series detail: seasons and episodes', async ({ page }) => {
    await page.goto('/title/series/tt0903747');
    await expect(page.getByRole('button', { name: 'Season 5' })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('episode')).toHaveCount(7);
    await expect(page.getByTestId('episode').first()).toContainText('Pilot');
    await page.getByRole('button', { name: 'Season 2' }).click();
    await expect(page.getByTestId('episode')).toHaveCount(13);
  });

  test('upcoming titles are clearly marked and not playable', async ({ page, request }) => {
    const home = await (await request.get('/api/catalog/home')).json();
    const upcoming = home.sections.find((s: any) => s.id === 'coming-soon')?.items?.[0];
    test.skip(!upcoming, 'no upcoming titles in the catalogue right now');
    await page.goto(`/title/${upcoming.type}/${upcoming.id}`);
    await expect(page.getByText(/not yet watchable/)).toBeVisible();
    await expect(page.getByTestId('watch-btn')).toHaveCount(0);
  });
});

test.describe('playback & personal data', () => {
  test('plays, saves progress, shows Continue Watching, and resumes', async ({ browser }) => {
    const { ctx, page } = await person(browser, 'Viewer');
    await page.goto('/watch/movie/tt0032599?t=600'); // His Girl Friday
    await expect.poll(() => videoTime(page), { timeout: 60_000 }).toBeGreaterThan(603);
    expect(await videoPaused(page)).toBe(false);
    await page.mouse.move(500, 300);
    await page.getByTestId('play-toggle').click(); // pause → progress saved
    await page.waitForTimeout(800);
    const pos = await videoTime(page);
    await page.goto('/');
    await expect(page.getByTestId('continue-watching')).toContainText('His Girl Friday', { timeout: 30_000 });
    await page.reload();
    await expect(page.getByTestId('continue-watching')).toContainText('His Girl Friday');
    await page.getByTestId('continue-watching').getByRole('link').first().click();
    await expect.poll(() => videoTime(page), { timeout: 60_000 }).toBeGreaterThan(pos - 1);
    expect(await videoTime(page)).toBeLessThan(pos + 15);
    await ctx.close();
  });

  test('watchlist and favorites persist to My List', async ({ browser }) => {
    const { ctx, page } = await person(browser, 'Lister');
    await page.goto('/title/movie/tt1187043');
    await page.getByTestId('watchlist-btn').click();
    await page.getByTestId('favorite-btn').click();
    await page.waitForTimeout(500);
    await page.goto('/library');
    await page.getByRole('button', { name: /Watchlist/ }).click();
    await expect(page.getByTestId('poster-card')).toContainText('3 Idiots');
    await page.getByRole('button', { name: /Favorites/ }).click();
    await expect(page.getByTestId('poster-card')).toContainText('3 Idiots');
    await ctx.close();
  });

  test('a failing source falls back automatically to the next verified one', async ({ page }) => {
    // keep the simulated failure from being recorded as a real one (2 reports demote a source for 6 h)
    await page.route('**/api/sources/report', (r) => r.fulfill({ json: { ok: true } }));
    const { sources } = await (await page.request.get('/api/sources/movie/tt0063350')).json();
    const first = sources.find((s: any) => s.verify.status === 'verified');
    expect(sources.filter((s: any) => s.verify.status === 'verified').length).toBeGreaterThan(1);
    let blocked = 0;
    await page.route((u) => u.toString() === first.url, (r) => { blocked++; return r.abort(); });
    await page.goto('/watch/movie/tt0063350');
    await expect.poll(() => videoTime(page), { timeout: 90_000 }).toBeGreaterThan(1);
    const src = await page.evaluate(() => document.querySelector('video')!.currentSrc);
    expect(blocked).toBeGreaterThan(0);
    expect(src).not.toBe(first.url);
    console.log('blocked', first.url, '→ fell back to', src);
  });

  test('subtitles render on screen and timing can be adjusted', async ({ page }) => {
    await page.goto('/watch/movie/tt1727587?t=100'); // Sintel — official English subs, first cue at 1:47
    await expect.poll(() => videoTime(page), { timeout: 60_000 }).toBeGreaterThan(100);
    await page.mouse.move(500, 300);
    await page.getByTestId('subs-menu').click();
    await page.getByRole('button', { name: /^English/ }).first().click();
    await page.getByRole('button', { name: '+0.5' }).click();
    await expect(page.getByTestId('sub-delay')).toHaveText('+0.5s');
    await expect(page.getByText('This blade has a dark past.')).toBeVisible({ timeout: 20_000 });
  });

  test('user-added source is verified before use', async ({ request }) => {
    const good = await (await request.post('/api/user-sources', { data: { titleId: 'tt1254207', mediaKey: 'tt1254207', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', label: 'Test HLS' } })).json();
    expect(good.kind).toBe('hls');
    expect(good.verify.status).toBe('verified');
    const bad = await (await request.post('/api/user-sources', { data: { titleId: 'tt1254207', mediaKey: 'tt1254207', url: 'https://archive.org/robots.txt' } })).json();
    expect(bad.verify.status).toBe('failed');
    await request.delete(`/api/user-sources/${good.id}`);
    await request.delete(`/api/user-sources/${bad.id}`);
  });
});

test.describe('mobile', () => {
  test('layouts fit a phone screen', async ({ browser }) => {
    const ctx = await browser.newContext({ ...devices['iPhone 13'], defaultBrowserType: undefined } as any);
    const page = await ctx.newPage();
    for (const path of ['/', '/title/series/tt0903747', '/browse/movie', '/library', '/rooms', '/settings']) {
      await page.goto(path);
      await page.waitForTimeout(2500);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(1);
    }
    await page.goto('/watch/movie/tt1727587?t=300');
    await expect.poll(() => videoTime(page), { timeout: 60_000 }).toBeGreaterThan(300);
    await page.touchscreen.tap(200, 300);
    await expect(page.getByTestId('play-toggle')).toBeVisible();
    await ctx.close();
  });
});
