import { expect, test } from '@playwright/test';
import { person } from './helpers';

test('voice/video call connects peer-to-peer inside a room', async ({ browser }) => {
  const a = await person(browser, 'Alice');
  const b = await person(browser, 'Bob');
  for (const p of [a, b]) await p.ctx.grantPermissions(['camera', 'microphone']);
  await a.page.goto('/rooms');
  await a.page.getByTestId('create-room').click();
  await a.page.waitForURL(/\/room\//);
  await expect(a.page.getByTestId('lobby')).toBeVisible();
  const link = await a.page.evaluate(() => { const id = location.pathname.split('/').pop(); return `${location.pathname}#k=${localStorage.getItem(`syncroom.room.${id}.key`)}`; });
  await b.page.goto(link);
  await expect(b.page.getByTestId('lobby')).toBeVisible();
  // load something so the player (and call dock) are shown
  await a.page.getByTestId('lobby-search').fill('Sintel');
  await a.page.getByTestId('lobby-item').filter({ hasText: 'Sintel' }).first().click();
  await expect(a.page.getByTestId('call-dock')).toBeVisible({ timeout: 60_000 });
  await expect(b.page.getByTestId('call-dock')).toBeVisible({ timeout: 60_000 });

  await a.page.mouse.move(400, 300);
  await a.page.getByTestId('call-dock').getByRole('button', { name: /Video/ }).click();
  await b.page.mouse.move(400, 300);
  await b.page.getByTestId('call-dock').getByRole('button', { name: /Video/ }).click();

  // Each side should end up with a connected peer carrying live remote audio + video
  for (const p of [a.page, b.page]) {
    await expect.poll(() => p.evaluate(() => {
      const bubbles = [...document.querySelectorAll('[data-testid=call-bubble] video')] as HTMLVideoElement[];
      const remote = bubbles.find((v) => !v.muted && v.srcObject);
      const s = remote?.srcObject as MediaStream | undefined;
      return s ? `${s.getAudioTracks().length}a${s.getVideoTracks().length}v${remote!.videoWidth > 0 ? '+frames' : ''}` : 'none';
    }), { timeout: 30_000 }).toBe('1a1v+frames');
  }
  await expect(a.page.getByTestId('call-bubble')).toHaveCount(2);
  // mute toggles propagate to the other side's participant state
  await a.page.getByRole('button', { name: 'Toggle microphone' }).click();
  await expect.poll(() => b.page.evaluate(() => (window as any).__syncroom.room.participants.find((p: any) => p.name === 'Alice')?.media?.mic), { timeout: 10_000 }).toBe(false);
  await a.ctx.close(); await b.ctx.close();
});
