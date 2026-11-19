import { describe, expect, it, vi } from 'vitest';
import { expectedPosition, type Participant, type RoomMedia, type RoomState } from '../../shared/types.ts';
import { ServerClock } from '../../web/src/sync/clock.ts';
import { applyCommand, START_LEAD_MS } from '../../server/rooms/roomManager.ts';

const base: RoomState = { roomId: 'r', name: 'n', hostId: 'a', media: null, playing: false, position: 0, rate: 1, updatedAt: 0, seq: 0, waitingFor: [], settings: { pauseOnBuffer: true, autoplayNext: true, hostOnly: false } };
const media = (episode: number): RoomMedia => ({ ref: { titleId: 'tt1', type: 'series', season: 1, episode }, sourceId: 's', source: {} as any, title: { id: 'tt1', type: 'series', name: 'Show' } });
const person = (id: string): Participant => ({ id, name: id, color: '#fff', connected: true, buffering: false, ready: true, lastSeen: 0 });
function room(state: Partial<RoomState> = {}) {
  const fakeWs = { readyState: 1, send: vi.fn() };
  return { state: { ...base, ...state }, conns: new Map([['a', { ws: fakeWs, participant: person('a'), ackSeq: 0 }], ['b', { ws: fakeWs, participant: person('b'), ackSeq: 0 }]]), known: new Map([['a', person('a')], ['b', person('b')]]) } as any;
}

describe('expectedPosition', () => {
  it('advances only while playing and nobody is waiting', () => {
    const s = { playing: true, position: 10, rate: 1, updatedAt: 1000, waitingFor: [] as string[] };
    expect(expectedPosition(s, 3000)).toBeCloseTo(12);
    expect(expectedPosition({ ...s, rate: 1.5 }, 3000)).toBeCloseTo(13);
    expect(expectedPosition({ ...s, playing: false }, 3000)).toBe(10);
    expect(expectedPosition({ ...s, waitingFor: ['b'] }, 3000)).toBe(10);
    expect(expectedPosition(s, 500)).toBe(10); // scheduled start in the future: hold
  });
});

describe('ServerClock', () => {
  it('estimates offset from the lowest-RTT samples despite asymmetric/jittery delays', () => {
    const c = new ServerClock();
    const trueOffset = 5000; // server is 5 s ahead
    let t = 1_000_000;
    for (let i = 0; i < 16; i++) {
      const up = 40 + (i % 4) * 60, down = 40 + ((i * 7) % 5) * 50; // jitter up to ~200 ms each way
      const serverTime = t + up + trueOffset;
      c.sample(t, serverTime, t + up + down);
      t += 1000;
    }
    expect(Math.abs(c.offset - trueOffset)).toBeLessThan(15);
    expect(c.synced).toBe(true);
  });
});

describe('room state machine', () => {
  it('play schedules a shared start slightly in the future', () => {
    const r = room({ media: media(1) });
    const before = Date.now();
    applyCommand(r, person('a'), { type: 'play' });
    expect(r.state.playing).toBe(true);
    expect(r.state.updatedAt).toBeGreaterThanOrEqual(before + START_LEAD_MS - 5);
    expect(r.state.seq).toBe(1);
  });
  it('pause freezes the position at the current expected time', () => {
    const r = room({ media: media(1), playing: true, position: 100, updatedAt: Date.now() - 2000 });
    applyCommand(r, person('b'), { type: 'pause' });
    expect(r.state.playing).toBe(false);
    expect(r.state.position).toBeGreaterThan(101.9);
    expect(r.state.position).toBeLessThan(102.2);
    expect(r.state.lastAction.by).toBe('b');
  });
  it('seek while playing makes everyone acknowledge before resuming', () => {
    const r = room({ media: media(1), playing: true, position: 5, updatedAt: Date.now() });
    applyCommand(r, person('a'), { type: 'seek', position: 600 });
    expect(r.state.position).toBe(600);
    expect(r.state.waitingFor.sort()).toEqual(['a', 'b']);
    expect(expectedPosition(r.state, Date.now() + 5000)).toBe(600);
  });
  it('episode end advances exactly once (duplicate "ended" from the other player is ignored)', () => {
    const r = room({ media: media(1), playing: true });
    applyCommand(r, person('a'), { type: 'ended', mediaKey: 'tt1:1:1', next: media(2) });
    expect(r.state.media.ref.episode).toBe(2);
    const seq = r.state.seq;
    applyCommand(r, person('b'), { type: 'ended', mediaKey: 'tt1:1:1', next: media(2) });
    expect(r.state.media.ref.episode).toBe(2);
    expect(r.state.seq).toBe(seq);
  });
  it('host-only rooms reject transport commands from guests', () => {
    const r = room({ media: media(1), settings: { ...base.settings, hostOnly: true } });
    expect(applyCommand(r, person('b'), { type: 'play' })).toMatch(/host/);
    expect(r.state.playing).toBe(false);
    expect(applyCommand(r, person('a'), { type: 'play' })).toBeNull();
  });
  it('last command wins when two people act at once', () => {
    const r = room({ media: media(1) });
    applyCommand(r, person('a'), { type: 'play' });
    applyCommand(r, person('b'), { type: 'pause' });
    expect(r.state.playing).toBe(false);
    expect(r.state.seq).toBe(2);
  });
});
