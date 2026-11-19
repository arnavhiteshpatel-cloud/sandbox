import { expectedPosition, type RoomState } from '@shared/types';
import type { PlayerEngine } from '../player/engines';
import type { RoomClient } from './roomClient';

export type SyncMode = 'loading' | 'waiting' | 'paused' | 'starting' | 'locked' | 'correcting' | 'seeking' | 'blocked' | 'error';
export interface SyncStats { mode: SyncMode; driftMs: number; rate: number; rttMs: number; offsetMs: number }

const TICK_MS = 120;
/** |drift| below this is considered in sync */
const LOCK_S = 0.03;
/** max playback-rate deviation used for gradual correction */
const MAX_NUDGE = 0.08;

/**
 * Keeps a local player locked to the room's authoritative timeline:
 *   expected = position + (serverNow − updatedAt) × rate   (while playing and nobody is waiting)
 * Small drift → gentle playback-rate nudging (frame-grade engines); large drift → seek (with learned latency);
 * scheduled starts → play at the exact server instant; holds → pause at the shared position.
 */
export class SyncController {
  private timer?: number;
  private playTimer?: number;
  private scheduledFor = 0;
  private lastSeekAt = 0;
  private seekStartedAt = 0;
  private seekLatency = 0.08;
  private bufferingSince: number | null = null;
  private lastStatus = { seq: -1, ready: false, buffering: false, sentAt: 0, error: '' };
  private blocked = false;
  private disposers: (() => void)[] = [];
  private loaded = false;
  private error: string | null = null;
  stats: SyncStats = { mode: 'loading', driftMs: 0, rate: 1, rttMs: 0, offsetMs: 0 };

  constructor(
    private engine: PlayerEngine,
    private room: RoomClient,
    private hooks: { onStats?: (s: SyncStats) => void; onBlocked?: (b: boolean) => void; onEnded?: () => void } = {},
  ) {}

  start() {
    this.disposers.push(
      this.room.onState((s, prev) => this.onState(s, prev)),
      this.engine.on('buffering', () => this.tick()),
      this.engine.on('seeked', () => this.onSeeked()),
      this.engine.on('state', (st) => { if (st === 'playing' && this.seekStartedAt) this.onSeeked(); }),
      this.engine.on('ended', () => this.hooks.onEnded?.()),
      this.engine.on('error', (e) => { if (e.fatal) { this.error = e.message; this.report(true); } }),
    );
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    (window as any).__syncroom = { ...((window as any).__syncroom ?? {}), controller: this, engine: this.engine, room: this.room };
  }

  markLoaded() { this.loaded = true; this.error = null; this.tick(); }
  markError(msg: string) { this.error = msg; this.report(true); }

  private onSeeked() {
    if (this.seekStartedAt) {
      const lat = (performance.now() - this.seekStartedAt) / 1000;
      if (lat < 3) this.seekLatency = this.seekLatency * 0.6 + lat * 0.4;
      this.seekStartedAt = 0;
    }
    this.tick();
  }

  private onState(s: RoomState, prev: RoomState | null) {
    if (prev && s.updatedAt !== prev.updatedAt) { clearTimeout(this.playTimer); this.scheduledFor = 0; }
    this.tick();
  }

  /** Call from a user gesture when the browser blocked autoplay. */
  async unblock() {
    try {
      await this.engine.play();
      this.blocked = false;
      this.hooks.onBlocked?.(false);
    } catch { /* still blocked */ }
    this.tick();
  }

  private seek(t: number, playing: boolean) {
    this.lastSeekAt = performance.now();
    this.seekStartedAt = playing ? performance.now() : 0;
    this.engine.seek(Math.max(0, t));
  }

  private setRate(r: number) {
    const caps = this.engine.capabilities;
    if (caps.setPlaybackRate !== true) {
      // discrete-rate engines only get the room's nominal rate
      if (Math.abs(this.engine.getPlaybackRate() - this.room.state!.rate) > 0.01) this.engine.setPlaybackRate(this.room.state!.rate);
      return;
    }
    if (Math.abs(this.engine.getPlaybackRate() - r) > 0.004) this.engine.setPlaybackRate(r);
  }

  private async tryPlay() {
    try {
      await this.engine.play();
      if (this.blocked) { this.blocked = false; this.hooks.onBlocked?.(false); }
    } catch (e) {
      if ((e as Error).name === 'NotAllowedError' && !this.blocked) { this.blocked = true; this.hooks.onBlocked?.(true); }
    }
  }

  private isReady(): boolean {
    const st = this.engine.getPlaybackState();
    if (!this.loaded || st === 'loading' || st === 'idle' || st === 'error') return false;
    if (this.engine.getBufferingState()) return false;
    const v = this.engine.video;
    if (v && (v.seeking || (v.readyState < 3 && this.engine.getBufferedAhead() < 1.5))) return false;
    return true;
  }

  tick() {
    const s = this.room.state;
    if (!s?.media || !this.loaded || this.error) { this.update(this.error ? 'error' : 'loading', 0); this.report(); return; }
    const now = this.room.clock.now();
    const exp = expectedPosition(s, now);
    const pos = this.engine.getCurrentTime();
    const playing = this.engine.getPlaybackState() === 'playing';
    const grade = this.engine.capabilities.syncGrade;
    const hard = grade === 'frame' ? 0.6 : 0.9;
    const sinceSeek = performance.now() - this.lastSeekAt;
    const holding = !s.playing || s.waitingFor.length > 0;

    if (holding) {
      clearTimeout(this.playTimer); this.scheduledFor = 0;
      if (playing) this.engine.pause();
      if (Math.abs(pos - exp) > 0.12 && sinceSeek > 400) this.seek(exp, false);
      this.setRate(s.rate);
      this.update(s.playing ? 'waiting' : 'paused', (pos - exp) * 1000);
    } else if (now < s.updatedAt - 15) {
      // Scheduled start: park at the start position, then play at exactly updatedAt (server clock).
      if (playing) this.engine.pause();
      if (Math.abs(pos - s.position) > 0.08 && sinceSeek > 300) this.seek(s.position, false);
      if (this.scheduledFor !== s.updatedAt) {
        this.scheduledFor = s.updatedAt;
        clearTimeout(this.playTimer);
        this.playTimer = window.setTimeout(() => { this.setRate(s.rate); this.tryPlay(); }, Math.max(0, s.updatedAt - this.room.clock.now()));
      }
      this.update('starting', (pos - s.position) * 1000);
    } else if (!playing) {
      if (this.blocked) { this.update('blocked', (pos - exp) * 1000); this.report(); return; }
      if (!this.engine.getBufferingState()) {
        if (Math.abs(pos - exp) > 0.25 && sinceSeek > 600) this.seek(exp + this.seekLatency * s.rate, true);
        this.setRate(s.rate);
        this.tryPlay();
      }
      this.update('starting', (pos - exp) * 1000);
    } else {
      const drift = pos - exp;
      if (Math.abs(drift) > hard && sinceSeek > 1500) {
        this.seek(exp + this.seekLatency * s.rate, true);
        this.setRate(s.rate);
        this.update('seeking', drift * 1000);
      } else if (Math.abs(drift) > LOCK_S && this.engine.capabilities.setPlaybackRate === true && sinceSeek > 250) {
        // close the gap over ~2.5 s, bounded
        const nudge = Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, -drift / 2.5));
        this.setRate(s.rate * (1 + nudge));
        this.update('correcting', drift * 1000);
      } else {
        this.setRate(s.rate);
        this.update(Math.abs(drift) <= LOCK_S || grade !== 'frame' ? 'locked' : 'correcting', drift * 1000);
      }
    }
    this.report();
  }

  private update(mode: SyncMode, driftMs: number) {
    this.stats = { mode, driftMs, rate: this.engine.getPlaybackRate?.() ?? 1, rttMs: this.room.clock.rtt, offsetMs: this.room.clock.offset };
    this.hooks.onStats?.(this.stats);
  }

  private report(force = false) {
    const s = this.room.state;
    if (!s) return;
    const ready = !this.error && this.isReady();
    const rawBuffering = !this.error && this.loaded && this.engine.getBufferingState() && s.playing;
    // Only report buffering after it persists (avoids pausing the room for tiny hiccups).
    if (rawBuffering) this.bufferingSince ??= performance.now(); else this.bufferingSince = null;
    const buffering = this.bufferingSince != null && performance.now() - this.bufferingSince > 700;
    const now = performance.now();
    const L = this.lastStatus;
    const err = this.error ?? '';
    if (force || L.seq !== s.seq || L.ready !== ready || L.buffering !== buffering || L.error !== err || now - L.sentAt > 2000) {
      this.room.send({ t: 'status', seq: s.seq, ready, buffering, driftMs: Math.round(this.stats.driftMs), rttMs: Math.round(this.room.clock.rtt), error: this.error ?? undefined });
      this.lastStatus = { seq: s.seq, ready, buffering, sentAt: now, error: err };
    }
  }

  destroy() {
    clearInterval(this.timer);
    clearTimeout(this.playTimer);
    this.disposers.forEach((d) => d());
  }
}
