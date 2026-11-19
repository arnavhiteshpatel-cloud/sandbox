import type { PlaybackSource, SourceCapabilities } from '@shared/types';
import { Emitter, type EmbeddedTrack, type EngineQuality, type PlaybackState, type PlayerEngine } from './types';

declare global { interface Window { YT?: any; onYouTubeIframeAPIReady?: () => void } }

let apiPromise: Promise<any> | null = null;
function loadApi(): Promise<any> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!apiPromise) {
    apiPromise = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => reject(new Error('Could not load the YouTube player'));
      document.head.appendChild(s);
    });
  }
  return apiPromise;
}

export function youtubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1) || null;
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    const m = u.pathname.match(/\/(embed|shorts|live)\/([\w-]{6,})/);
    return m ? m[2] : null;
  } catch { return /^[\w-]{11}$/.test(url) ? url : null; }
}

/** YouTube IFrame Player API: real play/pause/seek/time/state control. Discrete rates only; no caption API. */
export class YouTubeEngine extends Emitter implements PlayerEngine {
  kind: PlaybackSource['kind'] = 'youtube';
  capabilities!: SourceCapabilities;
  private player: any;
  private state: PlaybackState = 'idle';
  private buffering = false;
  private timer?: number;
  private host: HTMLDivElement;

  constructor(private container: HTMLElement) {
    super();
    this.host = document.createElement('div');
    this.host.className = 'w-full h-full';
    const inner = document.createElement('div');
    this.host.appendChild(inner);
    container.appendChild(this.host);
  }

  async load(source: PlaybackSource, startAt: number) {
    this.capabilities = source.capabilities;
    this.state = 'loading';
    const id = youtubeId(source.url);
    if (!id) throw new Error('Not a YouTube URL');
    const YT = await loadApi();
    await new Promise<void>((resolve, reject) => {
      this.player = new YT.Player(this.host.firstElementChild, {
        host: 'https://www.youtube-nocookie.com',
        videoId: id,
        width: '100%', height: '100%',
        playerVars: { controls: 0, disablekb: 1, modestbranding: 1, rel: 0, playsinline: 1, iv_load_policy: 3, fs: 0, start: Math.floor(startAt), origin: location.origin },
        events: {
          onReady: () => { this.setState('ready'); resolve(); },
          onError: (e: any) => {
            const msg = ({ 2: 'Invalid YouTube video id', 5: 'HTML5 player error', 100: 'Video removed or private', 101: 'Owner does not allow embedding', 150: 'Owner does not allow embedding' } as Record<number, string>)[e.data] ?? `YouTube error ${e.data}`;
            this.setState('error');
            this.emit('error', { message: msg, fatal: true });
            reject(new Error(msg));
          },
          onStateChange: (e: any) => {
            const s = e.data;
            if (s === 1) { this.setBuffering(false); this.setState('playing'); }
            else if (s === 2) { this.setBuffering(false); this.setState('paused'); }
            else if (s === 3) this.setBuffering(true);
            else if (s === 0) { this.setState('ended'); this.emit('ended', undefined); }
          },
          onPlaybackRateChange: (e: any) => this.emit('rate', e.data),
        },
      });
    });
    const iframe = this.host.querySelector('iframe');
    if (iframe) { iframe.style.width = '100%'; iframe.style.height = '100%'; iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture'); }
    if (startAt > 0) this.player.seekTo(startAt, true);
    this.timer = window.setInterval(() => { if (this.player?.getCurrentTime) { this.emit('time', this.getCurrentTime()); this.emit('duration', this.getDuration()); } }, 250);
  }

  private setState(s: PlaybackState) { if (s !== this.state) { this.state = s; this.emit('state', s); } }
  private setBuffering(b: boolean) { if (b !== this.buffering) { this.buffering = b; this.emit('buffering', b); } }

  async play() { this.player?.playVideo(); }
  pause() { this.player?.pauseVideo(); }
  seek(t: number) { this.player?.seekTo(Math.max(0, t), true); this.emit('seeked', undefined); }
  getCurrentTime() { return this.player?.getCurrentTime?.() ?? 0; }
  getDuration() { return this.player?.getDuration?.() ?? 0; }
  getPlaybackState() { return this.state; }
  getBufferingState() { return this.buffering; }
  getBufferedAhead() { const d = this.getDuration(); return d ? Math.max(0, (this.player.getVideoLoadedFraction?.() ?? 0) * d - this.getCurrentTime()) : 0; }
  getBufferedRanges(): [number, number][] { const d = this.getDuration(); return d ? [[0, (this.player.getVideoLoadedFraction?.() ?? 0) * d]] : []; }
  /** YouTube only accepts discrete rates; snap to the nearest available one. */
  setPlaybackRate(r: number) {
    const rates: number[] = this.player?.getAvailablePlaybackRates?.() ?? [1];
    const best = rates.reduce((a, b) => (Math.abs(b - r) < Math.abs(a - r) ? b : a), 1);
    this.player?.setPlaybackRate(best);
  }
  getPlaybackRate() { return this.player?.getPlaybackRate?.() ?? 1; }
  setVolume(v: number) { this.player?.setVolume(Math.round(v * 100)); }
  setMuted(m: boolean) { if (m) this.player?.mute(); else this.player?.unMute(); }
  getQualities(): EngineQuality[] { return []; }
  setQuality() { /* unsupported by the IFrame API since 2019 */ }
  getEmbeddedTracks(): EmbeddedTrack[] { return []; }
  setEmbeddedTrack() { /* unsupported */ }
  destroy() {
    clearInterval(this.timer);
    this.clear();
    try { this.player?.destroy(); } catch { /* */ }
    this.host.remove();
  }
}
