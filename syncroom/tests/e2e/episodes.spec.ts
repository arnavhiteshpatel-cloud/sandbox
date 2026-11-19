import { expect, test } from '@playwright/test';
import { person, roomState, videoPaused, videoTime } from './helpers';

// Sherlock Holmes (1954) — all episodes public domain, Internet Archive.
const SERIES = '/title/series/tt0046642';

test('episode switching and automatic next-episode transition stay together', async ({ browser }) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  await alice.page.goto(SERIES);
  await expect(alice.page.getByTestId('episode').first()).toBeVisible({ timeout: 60_000 });
  await expect(alice.page.getByText('Playable').first()).toBeVisible({ timeout: 90_000 });
  await alice.page.getByTestId('together-btn').click();
  await expect(alice.page.getByTestId('player')).toBeVisible({ timeout: 90_000 });
  const link = await alice.page.evaluate(() => { const id = location.pathname.split('/').pop(); return `${location.pathname}#k=${localStorage.getItem(`syncroom.room.${id}.key`)}`; });
  await bob.page.goto(link);
  await expect(bob.page.getByTestId('player')).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => !!(await roomState(bob.page))?.media, { timeout: 30_000 }).toBe(true);
  const first = (await roomState(bob.page)).media.ref;
  console.log('Started on', JSON.stringify(first));

  // Bob picks another episode from the in-player episode list → both switch
  await bob.page.mouse.move(400, 300);
  await bob.page.getByRole('button', { name: 'Episodes' }).click();
  const target = bob.page.locator('button', { hasText: /^E2/ }).first();
  await target.click();
  await expect.poll(async () => (await roomState(alice.page))?.media?.ref?.episode, { timeout: 60_000 }).toBe(2);
  await expect.poll(async () => (await roomState(alice.page))?.waitingFor?.length ?? 99, { timeout: 60_000 }).toBe(0);
  await expect.poll(() => videoPaused(alice.page), { timeout: 30_000 }).toBe(false);
  await expect.poll(() => videoPaused(bob.page), { timeout: 30_000 }).toBe(false);
  const srcA = await alice.page.evaluate(() => document.querySelector('video')!.currentSrc);
  const srcB = await bob.page.evaluate(() => document.querySelector('video')!.currentSrc);
  expect(srcA).toBe(srcB);
  console.log('Both on E2:', srcA);

  // Jump close to the end: when it ends, the room advances both players to E3 exactly once
  const dur = await alice.page.evaluate(() => document.querySelector('video')!.duration);
  await alice.page.evaluate((p) => (window as any).__syncroom.room.command({ type: 'seek', position: p }), dur - 6);
  await expect.poll(async () => (await roomState(bob.page))?.media?.ref?.episode, { timeout: 90_000 }).toBe(3);
  await expect.poll(async () => (await roomState(alice.page))?.waitingFor?.length ?? 99, { timeout: 60_000 }).toBe(0);
  await expect.poll(() => videoTime(bob.page), { timeout: 30_000 }).toBeGreaterThan(1);
  const [ta, tb] = [await videoTime(alice.page), await videoTime(bob.page)];
  console.log('Auto-advanced to E3, positions', ta.toFixed(2), tb.toFixed(2));
  expect(Math.abs(ta - tb)).toBeLessThan(0.3);
  await alice.ctx.close(); await bob.ctx.close();
});
