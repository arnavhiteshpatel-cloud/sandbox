import type { PlaybackSource, SourceCapabilities } from '@shared/types';
import { Emitter, type EmbeddedTrack, type EngineQuality, type PlaybackState, type PlayerEngine } from './types';

/** Direct media (MP4/WebM/MOV) through a <video> element. Also the base for HLS and DASH engines. */
export class Html5Engine extends Emitter implements PlayerEngine {
  readonly video: HTMLVideoElement;
  kind: PlaybackSource['kind'] = 'file';
  capabilities!: SourceCapabilities;
  protected source?: PlaybackSource;
  protected state: PlaybackState = 'idle';
  protected buffering = false;
  private qualityId = '';
  private disposers: (() => void)[] = [];

  constructor(protected container: HTMLElement) {
    super();
    const v = document.createElement('video');
    v.playsInline = true;
    v.preload = 'auto';
    v.className = 'w-full h-full object-contain bg-black';
    v.setAttribute('webkit-playsinline', '');
    container.appendChild(v);
    this.video = v;
    const on = (ev: string, fn: () => void) => { v.addEventListener(ev, fn); this.disposers.push(() => v.removeEventListener(ev, fn)); };
    on('playing', () => { this.setBuffering(false); this.setState('playing'); });
    on('pause', () => { if (this.state !== 'ended') this.setState('paused'); });
    on('waiting', () => this.setBuffering(true));
    on('stalled', () => { if (!v.paused && v.readyState < 3) this.setBuffering(true); });
    on('canplay', () => { this.setBuffering(false); if (this.state === 'loading') this.setState('ready'); });
    on('seeking', () => { if (v.readyState < 3) this.setBuffering(true); });
    on('seeked', () => { if (v.readyState >= 3) this.setBuffering(false); this.emit('seeked', undefined); });
    on('timeupdate', () => this.emit('time', v.currentTime));
    on('durationchange', () => this.emit('duration', this.getDuration()));
    on('ratechange', () => this.emit('rate', v.playbackRate));
    on('ended', () => { this.setState('ended'); this.emit('ended', undefined); });
    on('error', () => this.onMediaError());
  }

  protected setState(s: PlaybackState) { if (s !== this.state) { this.state = s; this.emit('state', s); } }
  protected setBuffering(b: boolean) { if (b !== this.buffering) { this.buffering = b; this.emit('buffering', b); } }

  protected onMediaError() {
    const e = this.video.error;
    const msg = !e ? 'Unknown media error' : ({ 1: 'Playback aborted', 2: 'Network error while loading video', 3: 'Video could not be decoded', 4: 'This video format is not supported by your browser, or the file is unavailable' } as Record<number, string>)[e.code] ?? e.message;
    this.setState('error');
    this.emit('error', { message: msg, fatal: true });
  }

  async load(source: PlaybackSource, startAt: number) {
    this.source = source;
    this.capabilities = source.capabilities;
    this.setState('loading');
    this.qualityId = source.qualities[0]?.id ?? '';
    await this.attach(source.url, startAt);
    if (source.qualities.length > 1) this.emit('qualities', this.getQualities());
  }

  protected attach(url: string, startAt: number) {
    return new Promise<void>((resolve, reject) => {
      const v = this.video;
      const done = () => { cleanup(); if (startAt > 0) v.currentTime = startAt; resolve(); };
      const fail = () => { cleanup(); reject(new Error(v.error?.message || 'Failed to load media')); };
      const cleanup = () => { v.removeEventListener('loadedmetadata', done); v.removeEventListener('error', fail); };
      v.addEventListener('loadedmetadata', done, { once: true });
      v.addEventListener('error', fail, { once: true });
      v.src = url;
      v.load();
    });
  }

  async play() { await this.video.play(); }
  pause() { this.video.pause(); }
  seek(t: number) {
    const d = this.getDuration();
    this.video.currentTime = Math.max(0, d ? Math.min(t, d - 0.05) : t);
  }
  getCurrentTime() { return this.video.currentTime; }
  getDuration() { const d = this.video.duration; return Number.isFinite(d) ? d : 0; }
  getPlaybackState() { return this.state; }
  getBufferingState() { return this.buffering || (!this.video.paused && this.video.readyState < 3); }
  getBufferedAhead() {
    const v = this.video, t = v.currentTime;
    for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= t + 0.2 && v.buffered.end(i) >= t) return v.buffered.end(i) - t;
    return 0;
  }
  getBufferedRanges() {
    const v = this.video, out: [number, number][] = [];
    for (let i = 0; i < v.buffered.length; i++) out.push([v.buffered.start(i), v.buffered.end(i)]);
    return out;
  }
  setPlaybackRate(r: number) { this.video.playbackRate = r; }
  getPlaybackRate() { return this.video.playbackRate; }
  setVolume(v: number) { this.video.volume = Math.max(0, Math.min(1, v)); }
  setMuted(m: boolean) { this.video.muted = m; }

  getQualities(): EngineQuality[] {
    return (this.source?.qualities ?? []).map((q) => ({ id: q.id, label: q.label, height: q.height }));
  }
  /** File sources: swap to another rendition, keeping time and play state. */
  setQuality(id: string) {
    const q = this.source?.qualities.find((x) => x.id === id);
    if (!q?.url || id === this.qualityId) return;
    const t = this.video.currentTime, wasPaused = this.video.paused, rate = this.video.playbackRate;
    this.qualityId = id;
    this.attach(q.url, t).then(() => { this.video.playbackRate = rate; if (!wasPaused) this.video.play().catch(() => {}); }).catch(() => {});
  }
  currentQuality() { return this.qualityId; }

  getEmbeddedTracks(): EmbeddedTrack[] { return []; }
  setEmbeddedTrack(_id: string | null) { /* direct files carry no in-band text tracks we expose */ }

  destroy() {
    this.disposers.forEach((d) => d());
    this.clear();
    try { this.video.pause(); this.video.removeAttribute('src'); this.video.load(); } catch { /* */ }
    this.video.remove();
  }
}
