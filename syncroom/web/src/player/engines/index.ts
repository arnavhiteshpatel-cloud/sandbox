import type { PlaybackSource } from '@shared/types';
import { DashEngine } from './dash';
import { HlsEngine } from './hls';
import { Html5Engine } from './html5';
import type { PlayerEngine } from './types';
import { VimeoEngine } from './vimeo';
import { YouTubeEngine } from './youtube';

/** Engine registry keyed by source kind — add a kind here and a provider can emit it. */
const ENGINES: Record<PlaybackSource['kind'], new (container: HTMLElement) => PlayerEngine> = {
  file: Html5Engine,
  hls: HlsEngine,
  dash: DashEngine,
  youtube: YouTubeEngine,
  vimeo: VimeoEngine,
};

export function createEngine(source: PlaybackSource, container: HTMLElement): PlayerEngine {
  return new ENGINES[source.kind](container);
}
export type { PlayerEngine } from './types';
