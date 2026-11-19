import Hls from 'hls.js';
import type { PlaybackSource } from '@shared/types';
import { Html5Engine } from './html5';
import { languageLabel, type EmbeddedTrack, type EngineQuality } from './types';

/** HLS via hls.js (MSE), or native HLS on Safari/iOS. */
export class HlsEngine extends Html5Engine {
  kind: PlaybackSource['kind'] = 'hls';
  private hls?: Hls;
  private netRetries = 0;

  protected attach(url: string, startAt: number): Promise<void> {
    if (!Hls.isSupported()) return super.attach(url, startAt); // Safari native HLS
    return new Promise((resolve, reject) => {
      const hls = new Hls({ startPosition: startAt > 0 ? startAt : -1, capLevelToPlayerSize: true, renderTextTracksNatively: true, maxBufferLength: 30, backBufferLength: 60 });
      this.hls = hls;
      let settled = false;
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        this.emit('qualities', this.getQualities());
        this.emit('tracks', this.getEmbeddedTracks());
      });
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => this.emit('tracks', this.getEmbeddedTracks()));
      hls.on(Hls.Events.FRAG_LOADED, () => { this.netRetries = 0; });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && this.netRetries < 4) {
          this.netRetries++;
          setTimeout(() => hls.startLoad(), 800 * this.netRetries);
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && this.netRetries < 2) {
          this.netRetries++;
          hls.recoverMediaError();
          return;
        }
        const msg = `HLS ${data.type}: ${data.details}`;
        if (!settled) { settled = true; reject(new Error(msg)); }
        this.setState('error');
        this.emit('error', { message: msg, fatal: true });
      });
      this.video.addEventListener('loadedmetadata', () => { if (!settled) { settled = true; resolve(); } }, { once: true });
      hls.loadSource(url);
      hls.attachMedia(this.video);
      hls.subtitleDisplay = false;
    });
  }

  getQualities(): EngineQuality[] {
    if (!this.hls) return [];
    const seen = new Set<number>();
    return this.hls.levels
      .map((l, i) => ({ id: String(i), label: l.height ? `${l.height}p` : `${Math.round(l.bitrate / 1000)} kb/s`, height: l.height }))
      .filter((q) => (q.height ? (seen.has(q.height) ? false : (seen.add(q.height), true)) : true))
      .sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
  }
  setQuality(id: string) {
    if (!this.hls) return;
    this.hls.currentLevel = id === 'auto' ? -1 : Number(id);
  }
  getEmbeddedTracks(): EmbeddedTrack[] {
    return (this.hls?.subtitleTracks ?? []).map((t, i) => ({ id: String(i), label: languageLabel(t.lang, t.name || undefined) || `Track ${i + 1}`, lang: t.lang ?? 'und' }));
  }
  setEmbeddedTrack(id: string | null) {
    if (!this.hls) return;
    this.hls.subtitleTrack = id == null ? -1 : Number(id);
    this.hls.subtitleDisplay = id != null;
  }
  destroy() {
    this.hls?.destroy();
    super.destroy();
  }
}
