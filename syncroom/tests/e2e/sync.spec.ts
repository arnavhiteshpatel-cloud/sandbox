import { expect, test } from '@playwright/test';
import { driftStats, person, roomState, startSampling, takeSamples, videoPaused, videoTime } from './helpers';

// Night of the Living Dead (1968) — public domain, Internet Archive direct MP4.
const MOVIE = '/title/movie/tt0063350';

test('two people watch in sync: join, play, pause, seek, drift, reconnect', async ({ browser }) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');

  // Alice creates a room from the title page
  await alice.page.goto(MOVIE);
  await expect(alice.page.getByTestId('together-btn')).toBeEnabled({ timeout: 60_000 });
  await alice.page.getByTestId('together-btn').click();
  await alice.page.waitForURL(/\/room\//);
  await expect(alice.page.getByTestId('player')).toBeVisible({ timeout: 60_000 });

  // Invitation link
  await alice.page.mouse.move(400, 300);
  await alice.page.getByTestId('invite-btn').click();
  const invite = await alice.page.getByTestId('invite-link').first().inputValue();
  expect(invite).toMatch(/\/room\/[\w-]+#k=/);
  await alice.page.keyboard.press('Escape');
  await alice.page.getByRole('button', { name: 'Done' }).click();

  // An uninvited person (no key) is refused
  const eve = await person(browser, 'Eve');
  await eve.page.goto(new URL(invite).pathname);
  await expect(eve.page.getByTestId('room-denied')).toBeVisible();
  await eve.ctx.close();

  // Bob joins with the link and gets the same title loaded
  await bob.page.goto(invite);
  await expect(bob.page.getByTestId('player')).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => (await roomState(bob.page))?.waitingFor?.length ?? 99, { timeout: 45_000 }).toBe(0);
  expect((await roomState(bob.page)).media.ref.titleId).toBe('tt0063350');

  // Alice presses play → both start together
  await alice.page.mouse.move(500, 300);
  await alice.page.getByTestId('play-toggle').click();
  await expect.poll(() => videoPaused(bob.page), { timeout: 20_000 }).toBe(false);
  await expect.poll(() => videoPaused(alice.page), { timeout: 20_000 }).toBe(false);

  // Measure drift for 20 s of normal playback
  await Promise.all([startSampling(alice.page), startSampling(bob.page)]);
  await alice.page.waitForTimeout(20_000);
  const [sa, sb] = await Promise.all([takeSamples(alice.page), takeSamples(bob.page)]);
  const drift = driftStats(sa, sb);
  console.log('DRIFT (play) ms', JSON.stringify(drift));
  expect(drift.n).toBeGreaterThan(100);
  expect(drift.p95).toBeLessThan(250);

  // Bob pauses → Alice pauses at the same frame
  await bob.page.mouse.move(500, 300);
  await bob.page.getByTestId('play-toggle').click();
  await expect.poll(() => videoPaused(alice.page), { timeout: 5_000 }).toBe(true);
  await alice.page.waitForTimeout(800);
  const [pa, pb] = await Promise.all([videoTime(alice.page), videoTime(bob.page)]);
  console.log('PAUSE positions', pa.toFixed(3), pb.toFixed(3), 'diff ms', Math.round(Math.abs(pa - pb) * 1000));
  expect(Math.abs(pa - pb)).toBeLessThan(0.2);

  // Bob seeks to 30:00 while paused → Alice follows
  await bob.page.evaluate(() => (window as any).__syncroom.room.command({ type: 'seek', position: 1800 }));
  await expect.poll(() => videoTime(alice.page), { timeout: 15_000 }).toBeGreaterThan(1799);
  const tA = await videoTime(alice.page);
  expect(tA).toBeLessThan(1801);

  // Alice plays again; then seek during playback; both resume in sync
  await alice.page.mouse.move(500, 300);
  await alice.page.getByTestId('play-toggle').click();
  await expect.poll(() => videoPaused(bob.page), { timeout: 20_000 }).toBe(false);
  await alice.page.evaluate(() => (window as any).__syncroom.room.command({ type: 'seek', position: 2400 }));
  await expect.poll(() => videoTime(bob.page), { timeout: 30_000 }).toBeGreaterThan(2400);
  await alice.page.waitForTimeout(4000);
  await Promise.all([startSampling(alice.page), startSampling(bob.page)]);
  await alice.page.waitForTimeout(10_000);
  const d2 = driftStats(await takeSamples(alice.page), await takeSamples(bob.page), 1000);
  console.log('DRIFT (after seek while playing) ms', JSON.stringify(d2));
  expect(d2.p95).toBeLessThan(250);

  // Bob disconnects (closes tab) and comes back: same title and position restored
  const beforeLeave = await videoTime(alice.page);
  await bob.page.close();
  await alice.page.waitForTimeout(3000);
  const bobPage2 = await bob.ctx.newPage();
  await bobPage2.goto(new URL(invite).pathname); // no key: the stored member token authenticates
  await expect(bobPage2.getByTestId('player')).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => (await videoPaused(bobPage2)) === false && (await videoTime(bobPage2)) > beforeLeave, { timeout: 45_000 }).toBe(true);
  await bobPage2.waitForTimeout(4000);
  const [ra, rb] = await Promise.all([videoTime(alice.page), videoTime(bobPage2)]);
  console.log('RECONNECT positions', ra.toFixed(2), rb.toFixed(2), 'diff ms', Math.round(Math.abs(ra - rb) * 1000));
  expect(Math.abs(ra - rb)).toBeLessThan(0.5);

  await alice.ctx.close();
  await bob.ctx.close();
});
