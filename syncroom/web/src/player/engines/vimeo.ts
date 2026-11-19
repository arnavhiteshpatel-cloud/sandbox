import VimeoPlayer from '@vimeo/player';
import type { PlaybackSource, SourceCapabilities } from '@shared/types';
import { Emitter, type EmbeddedTrack, type EngineQuality, type PlaybackState, type PlayerEngine } from './types';

/**
 * Vimeo Player SDK (postMessage). Control calls are asynchronous, so the current time is interpolated
 * from the last timeupdate. Arbitrary rates only work for PRO-owned videos.
 */
export class VimeoEngine extends Emitter implements PlayerEngine {
  kind: PlaybackSource['kind'] = 'vimeo';
  capabilities!: SourceCapabilities;
  private player?: VimeoPlayer;
  private host: HTMLDivElement;
  private state: PlaybackState = 'idle';
  private buffering = false;
  private t = 0;
  private tAt = performance.now();
  private dur = 0;
  private rate = 1;
  private tracks: EmbeddedTrack[] = [];

  constructor(private container: HTMLElement) {
    super();
    this.host = document.createElement('div');
    this.host.className = 'w-full h-full [&>iframe]:w-full [&>iframe]:h-full';
    container.appendChild(this.host);
  }

  async load(source: PlaybackSource, startAt: number) {
    this.capabilities = source.capabilities;
    this.state = 'loading';
    const p = new VimeoPlayer(this.host, { url: source.url, controls: false, playsinline: true, dnt: true, responsive: false, byline: false, title: false, portrait: false } as any);
    this.player = p;
    p.on('play', () => { this.setState('playing'); });
    p.on('playing', () => { this.setBuffering(false); this.setState('playing'); });
    p.on('pause', () => this.setState('paused'));
    p.on('bufferstart', () => this.setBuffering(true));
    p.on('bufferend', () => this.setBuffering(false));
    p.on('ended', () => { this.setState('ended'); this.emit('ended', undefined); });
    p.on('timeupdate', (d: { seconds: number; duration: number }) => { this.t = d.seconds; this.tAt = performance.now(); this.dur = d.duration; this.emit('time', d.seconds); });
    p.on('seeked', (d: { seconds: number }) => { this.t = d.seconds; this.tAt = performance.now(); this.emit('seeked', undefined); });
    p.on('playbackratechange', (d: { playbackRate: number }) => { this.rate = d.playbackRate; this.emit('rate', d.playbackRate); });
    p.on('error', (e: { message: string }) => { this.setState('error'); this.emit('error', { message: `Vimeo: ${e.message}`, fatal: true }); });
    await p.ready();
    this.dur = await p.getDuration();
    this.emit('duration', this.dur);
    try {
      this.tracks = (await p.getTextTracks()).map((t) => ({ id: `${t.language}|${t.kind}`, label: t.label, lang: t.language }));
      this.emit('tracks', this.tracks);
    } catch { /* */ }
    if (startAt > 0) await p.setCurrentTime(startAt);
    this.t = startAt;
    this.setState('ready');
  }

  private setState(s: PlaybackState) { if (s !== this.state) { this.state = s; this.emit('state', s); } }
  private setBuffering(b: boolean) { if (b !== this.buffering) { this.buffering = b; this.emit('buffering', b); } }

  async play() { await this.player?.play(); }
  pause() { this.player?.pause().catch(() => {}); }
  seek(s: number) { this.t = s; this.tAt = performance.now(); this.player?.setCurrentTime(Math.max(0, s)).catch(() => {}); }
  getCurrentTime() {
    return this.state === 'playing' && !this.buffering ? this.t + ((performance.now() - this.tAt) / 1000) * this.rate : this.t;
  }
  getDuration() { return this.dur; }
  getPlaybackState() { return this.state; }
  getBufferingState() { return this.buffering; }
  getBufferedAhead() { return 0; }
  getBufferedRanges(): [number, number][] { return []; }
  setPlaybackRate(r: number) { this.player?.setPlaybackRate(r).catch(() => {}); }
  getPlaybackRate() { return this.rate; }
  setVolume(v: number) { this.player?.setVolume(v).catch(() => {}); }
  setMuted(m: boolean) { this.player?.setMuted(m).catch(() => {}); }
  getQualities(): EngineQuality[] { return []; }
  setQuality() { /* PRO only — not exposed */ }
  getEmbeddedTracks() { return this.tracks; }
  setEmbeddedTrack(id: string | null) {
    if (!this.player) return;
    if (id == null) { this.player.disableTextTrack().catch(() => {}); return; }
    const [lang, kind] = id.split('|');
    this.player.enableTextTrack(lang, kind as any).catch(() => {});
  }
  destroy() {
    this.clear();
    this.player?.destroy().catch(() => {});
    this.host.remove();
  }
}
