import { expect, test } from '@playwright/test';
import { driftStats, person, roomState, startSampling, takeSamples, videoPaused, videoTime } from './helpers';

/**
 * Same machine, but Bob's room traffic gets 150 ms ± 60 ms simulated one-way latency (≈300 ms RTT with jitter),
 * which exercises clock-offset estimation and scheduled starts the way a real long-distance connection would.
 */
test('sync holds under 300 ms RTT with jitter', async ({ browser }) => {
  const alice = await person(browser, 'Alice');
  const bob = await person(browser, 'Bob');
  await bob.ctx.addInitScript(() => localStorage.setItem('syncroom.debugLag', '150,60'));

  await alice.page.goto('/title/movie/tt0032599'); // His Girl Friday (1940), public domain
  await expect(alice.page.getByTestId('watch-btn')).toBeVisible({ timeout: 90_000 });
  await alice.page.getByTestId('together-btn').click();
  await expect(alice.page.getByTestId('player')).toBeVisible({ timeout: 60_000 });
  const key = await alice.page.evaluate(() => { const id = location.pathname.split('/').pop(); return `${location.pathname}#k=${localStorage.getItem(`syncroom.room.${id}.key`)}`; });
  await bob.page.goto(key);
  await expect(bob.page.getByTestId('player')).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => (await roomState(bob.page))?.waitingFor?.length ?? 99, { timeout: 45_000 }).toBe(0);

  await bob.page.waitForTimeout(3000); // let Bob's clock estimate settle
  const rtt = await bob.page.evaluate(() => (window as any).__syncroom.room.clock.rtt);
  console.log('Bob measured RTT ms', rtt);

  await bob.page.mouse.move(400, 300);
  await bob.page.getByTestId('play-toggle').click(); // the laggy participant starts playback
  await expect.poll(() => videoPaused(alice.page), { timeout: 20_000 }).toBe(false);
  await Promise.all([startSampling(alice.page), startSampling(bob.page)]);
  await alice.page.waitForTimeout(25_000);
  const d = driftStats(await takeSamples(alice.page), await takeSamples(bob.page), 4000);
  console.log('DRIFT (300ms RTT, jitter) ms', JSON.stringify(d));
  expect(d.p95).toBeLessThan(250);

  // seek by the laggy participant
  await bob.page.evaluate(() => (window as any).__syncroom.room.command({ type: 'seek', position: 1200 }));
  await expect.poll(() => videoTime(alice.page), { timeout: 30_000 }).toBeGreaterThan(1200);
  await alice.page.waitForTimeout(5000);
  await Promise.all([startSampling(alice.page), startSampling(bob.page)]);
  await alice.page.waitForTimeout(10_000);
  const d2 = driftStats(await takeSamples(alice.page), await takeSamples(bob.page), 1000);
  console.log('DRIFT (300ms RTT, after seek) ms', JSON.stringify(d2));
  expect(d2.p95).toBeLessThan(250);
  await alice.ctx.close(); await bob.ctx.close();
});
