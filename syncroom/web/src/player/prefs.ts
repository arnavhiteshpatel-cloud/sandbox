import { store } from '../lib/identity';

export interface PlayerPrefs {
  volume: number;
  muted: boolean;
  rate: number;
  subtitleLang: string | null;
  subtitleSize: number;
  subtitleBg: boolean;
  quality: 'auto' | string;
  autoplayNext: boolean;
}

const DEFAULTS: PlayerPrefs = { volume: 1, muted: false, rate: 1, subtitleLang: null, subtitleSize: 1, subtitleBg: true, quality: 'auto', autoplayNext: true };

export function loadPrefs(): PlayerPrefs {
  try { return { ...DEFAULTS, ...JSON.parse(store.get('syncroom.player') ?? '{}') }; } catch { return DEFAULTS; }
}
export function savePrefs(p: Partial<PlayerPrefs>) {
  store.set('syncroom.player', JSON.stringify({ ...loadPrefs(), ...p }));
}
