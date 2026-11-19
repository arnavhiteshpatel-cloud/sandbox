import type { PlaybackSource } from '@shared/types';
import { Html5Engine } from './html5';
import { languageLabel, type EmbeddedTrack, type EngineQuality } from './types';

type Shaka = typeof import('shaka-player');

/** MPEG-DASH via Shaka Player (lazy-loaded). */
export class DashEngine extends Html5Engine {
  kind: PlaybackSource['kind'] = 'dash';
  private player?: any;

  protected async attach(url: string, startAt: number): Promise<void> {
    const mod = (await import('shaka-player/dist/shaka-player.compiled.js')) as unknown as { default: Shaka };
    const shaka = (mod.default ?? mod) as any;
    shaka.polyfill.installAll();
    if (!shaka.Player.isBrowserSupported()) throw new Error('DASH is not supported in this browser');
    if (!this.player) {
      this.player = new shaka.Player();
      await this.player.attach(this.video);
      this.player.configure({ streaming: { bufferingGoal: 30, rebufferingGoal: 2, retryParameters: { maxAttempts: 4, baseDelay: 800 } } });
      this.player.addEventListener('error', (e: any) => {
        const d = e.detail;
        this.setState('error');
        this.emit('error', { message: `DASH error ${d?.code ?? ''} ${d?.message ?? ''}`.trim(), fatal: d?.severity === 2 });
      });
      this.player.addEventListener('trackschanged', () => { this.emit('qualities', this.getQualities()); this.emit('tracks', this.getEmbeddedTracks()); });
    }
    await this.player.load(url, startAt > 0 ? startAt : null);
    this.emit('qualities', this.getQualities());
    this.emit('tracks', this.getEmbeddedTracks());
  }

  /** Shaka ≥5 exposes getVideoTracks/selectVideoTrack; older versions only variant tracks. */
  private videoTracks(): any[] {
    if (!this.player) return [];
    if (typeof this.player.getVideoTracks === 'function') return this.player.getVideoTracks() ?? [];
    return this.player.getVariantTracks?.() ?? [];
  }
  getQualities(): EngineQuality[] {
    const seen = new Set<number>();
    return this.videoTracks()
      .filter((t) => t.height && !seen.has(t.height) && seen.add(t.height))
      .sort((a, b) => b.height - a.height)
      .map((t) => ({ id: String(t.height), label: `${t.height}p`, height: t.height }));
  }
  setQuality(id: string) {
    if (!this.player) return;
    if (id === 'auto') { this.player.configure({ abr: { enabled: true } }); return; }
    const h = Number(id);
    const track = this.videoTracks().filter((t) => t.height === h).sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];
    if (!track) return;
    this.player.configure({ abr: { enabled: false } });
    if (typeof this.player.selectVideoTrack === 'function') this.player.selectVideoTrack(track, true);
    else this.player.selectVariantTrack(track, true);
  }
  getEmbeddedTracks(): EmbeddedTrack[] {
    return ((this.player?.getTextTracks?.() ?? []) as any[]).map((t) => ({ id: String(t.id), label: languageLabel(t.language, t.label || undefined), lang: t.language }));
  }
  setEmbeddedTrack(id: string | null) {
    if (!this.player) return;
    const legacyVisibility = typeof this.player.setTextTrackVisibility === 'function';
    if (id == null) {
      if (legacyVisibility) this.player.setTextTrackVisibility(false);
      else this.player.selectTextTrack?.(null);
      return;
    }
    const t = (this.player.getTextTracks() as any[]).find((x) => String(x.id) === id);
    if (!t) return;
    this.player.selectTextTrack(t);
    if (legacyVisibility) this.player.setTextTrackVisibility(true);
  }
  destroy() {
    this.player?.destroy().catch?.(() => {});
    super.destroy();
  }
}
