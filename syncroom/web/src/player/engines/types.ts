import type { PlaybackSource, SourceCapabilities } from '@shared/types';

export type PlaybackState = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'ended' | 'error';

export interface EngineQuality { id: string; label: string; height?: number }
export interface EmbeddedTrack { id: string; label: string; lang: string }

export interface EngineEvents {
  state: PlaybackState;
  time: number;
  duration: number;
  buffering: boolean;
  ended: void;
  error: { message: string; fatal: boolean };
  qualities: EngineQuality[];
  tracks: EmbeddedTrack[];
  seeked: void;
  rate: number;
}

/**
 * Client half of a provider adapter. Capabilities the underlying player cannot provide are reported as
 * unsupported (see `capabilities`) instead of being simulated.
 */
export interface PlayerEngine {
  readonly kind: PlaybackSource['kind'];
  readonly capabilities: SourceCapabilities;
  /** Underlying <video> for engines that have one (PiP, cue rendering) */
  readonly video?: HTMLVideoElement;
  load(source: PlaybackSource, startAt: number): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlaybackState(): PlaybackState;
  getBufferingState(): boolean;
  /** Seconds buffered ahead of the playhead (0 if unknown) */
  getBufferedAhead(): number;
  getBufferedRanges(): [number, number][];
  setPlaybackRate(rate: number): void;
  getPlaybackRate(): number;
  setVolume(v: number): void;
  setMuted(m: boolean): void;
  getQualities(): EngineQuality[];
  setQuality(id: string | 'auto'): void;
  getEmbeddedTracks(): EmbeddedTrack[];
  setEmbeddedTrack(id: string | null): void;
  on<K extends keyof EngineEvents>(ev: K, fn: (v: EngineEvents[K]) => void): () => void;
  destroy(): void;
}

export class Emitter {
  private map = new Map<string, Set<(v: any) => void>>();
  on<K extends keyof EngineEvents>(ev: K, fn: (v: EngineEvents[K]) => void) {
    if (!this.map.has(ev)) this.map.set(ev, new Set());
    this.map.get(ev)!.add(fn);
    return () => this.map.get(ev)?.delete(fn);
  }
  emit<K extends keyof EngineEvents>(ev: K, v: EngineEvents[K]) {
    this.map.get(ev)?.forEach((fn) => { try { fn(v); } catch (e) { console.error(e); } });
  }
  clear() { this.map.clear(); }
}

const names = typeof Intl !== 'undefined' && 'DisplayNames' in Intl ? new Intl.DisplayNames(['en'], { type: 'language' }) : null;
/** "nl" / "dut" / "pt-BR" → "Dutch" / "Portuguese (Brazil)" */
export function languageLabel(code?: string, fallback?: string): string {
  if (fallback && fallback !== code) return fallback;
  if (!code || code === 'und') return fallback || 'Unknown';
  const three: Record<string, string> = { dut: 'nl', eng: 'en', fre: 'fr', ger: 'de', ita: 'it', spa: 'es', por: 'pt', rus: 'ru', pol: 'pl', jpn: 'ja', chi: 'zh', kor: 'ko', hin: 'hi', ara: 'ar', swe: 'sv' };
  try { return names?.of(three[code] ?? code) ?? code; } catch { return code; }
}
