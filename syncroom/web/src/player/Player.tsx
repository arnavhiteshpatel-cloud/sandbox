import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft, Captions, Check, ChevronRight, Gauge, Layers, ListVideo, Loader2, Maximize, Minimize, Pause, PictureInPicture2, Play,
  RotateCcw, RotateCw, Server, Settings2, SkipForward, Upload, Volume1, Volume2, VolumeX, AlertTriangle,
} from 'lucide-react';
import type { Episode, MediaRef, PlaybackSource, TitleDetail } from '@shared/types';
import { expectedPosition } from '@shared/types';
import { api } from '../lib/api';
import { clock, cx, epCode } from '../lib/format';
import type { RoomClient } from '../sync/roomClient';
import { SyncController, type SyncStats } from '../sync/syncController';
import { createEngine, type PlayerEngine } from './engines';
import type { EmbeddedTrack, EngineQuality, PlaybackState } from './engines/types';
import { loadPrefs, savePrefs } from './prefs';
import { activeCues, loadCues, parseVtt, type Cue } from './subtitles';

export interface PlayerProps {
  detail: TitleDetail;
  mediaRef: MediaRef;
  source: PlaybackSource;
  sources: PlaybackSource[];
  onSourceChange: (s: PlaybackSource, position: number) => void;
  onEpisode: (ref: MediaRef) => void;
  onBack: () => void;
  startAt?: number;
  room?: RoomClient;
  /** room-mode extras rendered in the top bar (participants, invite, call) */
  topRight?: ReactNode;
  overlay?: ReactNode;
  onRoomEnded?: () => void;
}

const RATES = [0.5, 0.75, 1, 1.1, 1.25, 1.5, 2];

export function Player(props: PlayerProps) {
  const { detail, mediaRef, source, sources, room } = props;
  const prefs = useMemo(loadPrefs, []);
  const shellRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<PlayerEngine | null>(null);
  const syncRef = useRef<SyncController | null>(null);
  const [state, setState] = useState<PlaybackState>('loading');
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffering, setBuffering] = useState(false);
  const [buffered, setBuffered] = useState<[number, number][]>([]);
  const [volume, setVolume] = useState(prefs.volume);
  const [muted, setMuted] = useState(prefs.muted);
  const [rate, setRate] = useState(room ? 1 : prefs.rate);
  const [qualities, setQualities] = useState<EngineQuality[]>([]);
  const [quality, setQuality] = useState<string>('auto');
  const [embedded, setEmbedded] = useState<EmbeddedTrack[]>([]);
  const [subId, setSubId] = useState<string | null>(null);
  const [userSub, setUserSub] = useState<{ label: string; cues: Cue[] } | null>(null);
  const [cues, setCues] = useState<Cue[]>([]);
  const [subDelay, setSubDelay] = useState(0);
  const [subSize, setSubSize] = useState(prefs.subtitleSize);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<null | 'settings' | 'subs' | 'source' | 'episodes'>(null);
  const [settingsPage, setSettingsPage] = useState<'root' | 'quality' | 'speed'>('root');
  const [idle, setIdle] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [syncStats, setSyncStats] = useState<SyncStats | null>(null);
  const [nextCountdown, setNextCountdown] = useState<number | null>(null);
  const [scrubbing, setScrubbing] = useState<number | null>(null);
  const startedRef = useRef(false);
  const triedRef = useRef(new Set<string>());

  const episodes = detail.episodes ?? [];
  const currentEp = mediaRef.type === 'series' ? episodes.find((e) => e.season === mediaRef.season && e.episode === mediaRef.episode) : undefined;
  const nextEp: Episode | undefined = useMemo(() => {
    if (!currentEp) return undefined;
    const i = episodes.indexOf(currentEp);
    return episodes.slice(i + 1).find((e) => e.season > 0 && !e.upcoming);
  }, [currentEp, episodes]);

  const flash = useCallback((m: string) => { setToast(m); window.setTimeout(() => setToast((t) => (t === m ? null : t)), 2600); }, []);

  // ------------------------------------------------------------ engine lifecycle
  useEffect(() => {
    const stage = stageRef.current!;
    const engine = createEngine(source, stage);
    engineRef.current = engine;
    startedRef.current = false;
    triedRef.current.add(source.id);
    setState('loading'); setError(null); setQualities([]); setEmbedded([]); setBuffering(true); setDuration(source.durationSec ?? 0);
    const offs = [
      engine.on('state', (s) => { setState(s); if (s === 'playing') startedRef.current = true; }),
      engine.on('time', (t) => setTime(t)),
      engine.on('duration', (d) => setDuration(d)),
      engine.on('buffering', (b) => setBuffering(b)),
      engine.on('qualities', (q) => setQualities(q)),
      engine.on('tracks', (t) => setEmbedded(t)),
      engine.on('rate', (r) => { if (!room) setRate(r); }),
      engine.on('error', (e) => { if (e.fatal) fail(e.message); }),
    ];
    let okTimer = 0;
    const startAt = room ? expectedPosition(room.state!, room.clock.now()) : props.startAt ?? 0;
    engine.load(source, startAt).then(() => {
      setBuffering(false);
      engine.setVolume(volume);
      engine.setMuted(muted);
      setDuration(engine.getDuration() || source.durationSec || 0);
      if (prefs.quality !== 'auto' && engine.getQualities().some((q) => q.id === prefs.quality)) { engine.setQuality(prefs.quality); setQuality(prefs.quality); }
      if (room) {
        const sc = new SyncController(engine, room, { onStats: setSyncStats, onBlocked: setBlocked, onEnded: () => props.onRoomEnded?.() });
        syncRef.current = sc;
        sc.start();
        sc.markLoaded();
      } else {
        engine.setPlaybackRate(rate);
        engine.play().catch((e) => { if ((e as Error).name === 'NotAllowedError') setBlocked(true); });
      }
      okTimer = window.setTimeout(() => { if (engine.getCurrentTime() > 3) api.report(source, true); }, 12000);
    }).catch((e) => fail((e as Error).message));

    function fail(message: string) {
      setError(message);
      setBuffering(false);
      api.report(source, false, message);
      syncRef.current?.markError(message);
      // Solo: fall back automatically to the next verified source if this one never started.
      if (!room && !startedRef.current) {
        const next = sources.find((s) => !triedRef.current.has(s.id) && s.verify.status !== 'failed');
        if (next) {
          flash(`Source failed — switching to ${next.providerName}`);
          window.setTimeout(() => props.onSourceChange(next, engine.getCurrentTime() || props.startAt || 0), 900);
        }
      }
    }

    const bufTimer = window.setInterval(() => setBuffered(engine.getBufferedRanges()), 1000);
    return () => {
      offs.forEach((o) => o());
      clearTimeout(okTimer);
      clearInterval(bufTimer);
      syncRef.current?.destroy();
      syncRef.current = null;
      engine.destroy();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.id, source.url]);

  // ------------------------------------------------------------ subtitles
  const externalTracks = source.subtitles;
  useEffect(() => {
    // restore preferred language
    if (subId === null && prefs.subtitleLang) {
      const t = externalTracks.find((x) => x.lang === prefs.subtitleLang);
      if (t) setSubId(t.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.id]);
  useEffect(() => {
    const setEmb = (id: string | null) => { try { engineRef.current?.setEmbeddedTrack(id); } catch (e) { console.warn('[subtitles]', e); } };
    if (!subId) { setCues([]); setEmb(null); return; }
    if (subId === 'user' && userSub) { setCues(userSub.cues); return; }
    if (subId.startsWith('emb:')) { setCues([]); setEmb(subId.slice(4)); return; }
    setEmb(null);
    const t = externalTracks.find((x) => x.id === subId);
    if (!t) return;
    let cancelled = false;
    loadCues(t.url).then((c) => !cancelled && setCues(c)).catch((e) => { flash(`Subtitles unavailable: ${(e as Error).message}`); setSubId(null); });
    return () => { cancelled = true; };
  }, [subId, externalTracks, userSub, flash]);
  const shownCues = useMemo(() => activeCues(cues, time - subDelay), [cues, time, subDelay]);

  // ------------------------------------------------------------ progress saving
  const saveProgress = useCallback(() => {
    const e = engineRef.current;
    if (!e || !startedRef.current) return;
    const { people, trailers, episodes: _e, seasons, ...summary } = detail;
    void people; void trailers; void _e; void seasons;
    api.saveProgress({ ref: mediaRef, title: summary, episodeName: currentEp?.name, position: e.getCurrentTime(), duration: e.getDuration() || duration, sourceId: source.id });
  }, [detail, mediaRef, currentEp, duration, source.id]);
  useEffect(() => {
    const i = window.setInterval(() => { if (engineRef.current?.getPlaybackState() === 'playing') saveProgress(); }, 10000);
    const onHide = () => saveProgress();
    window.addEventListener('pagehide', onHide);
    return () => { clearInterval(i); window.removeEventListener('pagehide', onHide); saveProgress(); };
  }, [saveProgress]);
  useEffect(() => { if (state === 'paused' || state === 'ended') saveProgress(); }, [state, saveProgress]);

  // ------------------------------------------------------------ next episode
  useEffect(() => {
    if (state !== 'ended' || room || !nextEp || !prefs.autoplayNext) return;
    setNextCountdown(8);
  }, [state, room, nextEp, prefs.autoplayNext]);
  useEffect(() => {
    if (nextCountdown == null) return;
    if (nextCountdown <= 0) { setNextCountdown(null); goNext(); return; }
    const t = window.setTimeout(() => setNextCountdown((c) => (c == null ? null : c - 1)), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextCountdown]);
  const goNext = useCallback(() => {
    if (!nextEp) return;
    props.onEpisode({ titleId: mediaRef.titleId, type: 'series', season: nextEp.season, episode: nextEp.episode });
  }, [nextEp, mediaRef.titleId, props]);

  // ------------------------------------------------------------ transport actions (room-aware)
  const playing = state === 'playing' || (room?.state?.playing ?? false);
  const togglePlay = useCallback(() => {
    const e = engineRef.current;
    if (!e) return;
    if (blocked) { setBlocked(false); if (room) syncRef.current?.unblock(); else e.play().catch(() => {}); return; }
    if (room) {
      const rs = room.state;
      if (rs?.playing) { e.pause(); room.command({ type: 'pause' }); } else room.command({ type: 'play' });
      return;
    }
    if (e.getPlaybackState() === 'playing') e.pause();
    else if (e.getPlaybackState() === 'ended') { e.seek(0); e.play().catch(() => {}); }
    else e.play().catch(() => {});
  }, [room, blocked]);

  const seekTo = useCallback((t: number) => {
    const e = engineRef.current;
    if (!e) return;
    const d = e.getDuration() || duration;
    const target = Math.max(0, d ? Math.min(t, d - 0.5) : t);
    e.seek(target);
    setTime(target);
    if (room) room.command({ type: 'seek', position: target });
  }, [room, duration]);

  const changeRate = useCallback((r: number) => {
    setRate(r);
    if (room) room.command({ type: 'rate', rate: r });
    else { engineRef.current?.setPlaybackRate(r); savePrefs({ rate: r }); }
  }, [room]);

  const changeVolume = useCallback((v: number) => {
    setVolume(v); setMuted(v === 0);
    engineRef.current?.setVolume(v); engineRef.current?.setMuted(v === 0);
    savePrefs({ volume: v, muted: v === 0 });
  }, []);
  const toggleMute = useCallback(() => {
    setMuted((m) => { engineRef.current?.setMuted(!m); savePrefs({ muted: !m }); if (m && volume === 0) { setVolume(0.6); engineRef.current?.setVolume(0.6); } return !m; });
  }, [volume]);

  const toggleFullscreen = useCallback(() => {
    const el = shellRef.current as any;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (el?.requestFullscreen) el.requestFullscreen().catch(() => {});
    else (engineRef.current?.video as any)?.webkitEnterFullscreen?.();
  }, []);
  useEffect(() => {
    const f = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', f);
    return () => document.removeEventListener('fullscreenchange', f);
  }, []);

  const togglePip = useCallback(async () => {
    const v = engineRef.current?.video;
    if (!v) return;
    try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await v.requestPictureInPicture(); } catch (e) { flash((e as Error).message); }
  }, [flash]);

  const chooseSub = (id: string | null) => {
    setSubId(id);
    const t = externalTracks.find((x) => x.id === id);
    savePrefs({ subtitleLang: t?.lang ?? null });
  };

  // ------------------------------------------------------------ keyboard + idle
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const e = engineRef.current;
      if (!e) return;
      const k = ev.key.toLowerCase();
      const handled = true;
      if (k === ' ' || k === 'k') togglePlay();
      else if (k === 'arrowleft' || k === 'j') seekTo(e.getCurrentTime() - (k === 'j' ? 10 : 5));
      else if (k === 'arrowright' || k === 'l') seekTo(e.getCurrentTime() + (k === 'l' ? 10 : 5));
      else if (k === 'arrowup') changeVolume(Math.min(1, volume + 0.1));
      else if (k === 'arrowdown') changeVolume(Math.max(0, volume - 0.1));
      else if (k === 'f') toggleFullscreen();
      else if (k === 'm') toggleMute();
      else if (k === 'p') togglePip();
      else if (k === 'c') chooseSub(subId ? null : externalTracks[0]?.id ?? (embedded[0] ? `emb:${embedded[0].id}` : null));
      else if (k === 'n' && nextEp) room ? props.onEpisode({ titleId: mediaRef.titleId, type: 'series', season: nextEp.season, episode: nextEp.episode }) : goNext();
      else if (ev.key === '>' ) changeRate(RATES[Math.min(RATES.length - 1, RATES.indexOf(rate) + 1)] ?? 1);
      else if (ev.key === '<') changeRate(RATES[Math.max(0, RATES.indexOf(rate) - 1)] ?? 1);
      else if (k === 'g') setSubDelay((d) => +(d - 0.1).toFixed(1));
      else if (k === 'h') setSubDelay((d) => +(d + 0.1).toFixed(1));
      else if (k === 'escape') setMenu(null);
      else if (/^[0-9]$/.test(k)) seekTo((e.getDuration() || duration) * (Number(k) / 10));
      else return;
      if (handled) { ev.preventDefault(); poke(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const idleTimer = useRef<number | undefined>(undefined);
  const poke = useCallback(() => {
    setIdle(false);
    clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), 3200);
  }, []);
  useEffect(() => { poke(); return () => clearTimeout(idleTimer.current); }, [poke]);
  const controlsVisible = !idle || !playing || !!menu || !!error || state === 'loading';

  // ------------------------------------------------------------ scrubber
  const barRef = useRef<HTMLDivElement>(null);
  const posFromEvent = (clientX: number) => {
    const r = barRef.current!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return { x: f * r.width, t: f * (duration || 0) };
  };
  const shownTime = scrubbing ?? time;
  const progress = duration ? (shownTime / duration) * 100 : 0;
  const remaining = duration - time;
  const showUpNext = !!nextEp && duration > 120 && remaining > 0 && remaining < 30 && !error;

  const loadUserSub = (file: File) => {
    file.text().then((txt) => {
      const c = parseVtt(txt);
      if (!c.length) { flash('No subtitles found in that file'); return; }
      setUserSub({ label: file.name, cues: c });
      setSubId('user');
      flash(`Loaded ${c.length} subtitle cues`);
    });
  };

  const syncLabel = syncStats ? {
    loading: 'Loading', waiting: 'Waiting for everyone', paused: 'Paused together', starting: 'Starting together', locked: 'In sync',
    correcting: 'Syncing', seeking: 'Re-syncing', blocked: 'Tap to play', error: 'Source error',
  }[syncStats.mode] : '';

  return (
    <div
      ref={shellRef}
      data-testid="player"
      className={cx('relative w-full h-full bg-black overflow-hidden select-none', !controlsVisible && 'cursor-none')}
      onMouseMove={poke}
      onTouchStart={poke}
    >
      <div ref={stageRef} className="absolute inset-0 [&>video]:w-full [&>video]:h-full" onClick={() => { if (menu) setMenu(null); else togglePlay(); }} onDoubleClick={toggleFullscreen} />

      {/* subtitles */}
      {shownCues.length > 0 && (
        <div className={cx('pointer-events-none absolute inset-x-0 flex flex-col items-center px-6 transition-all duration-300', controlsVisible ? 'bottom-28' : 'bottom-10')}>
          {shownCues.map((c, i) => (
            <div key={i} className="max-w-[86%] text-center leading-snug rounded-md px-3 py-1 mb-1 bg-black/60 text-white" style={{ fontSize: `clamp(15px, ${2.1 * subSize}vw, ${36 * subSize}px)`, textShadow: '0 1px 3px rgba(0,0,0,.9)' }}
              dangerouslySetInnerHTML={{ __html: c.text.replace(/</g, '&lt;').replace(/&lt;(\/?)(i|b|u)>/g, '<$1$2>').replace(/\n/g, '<br/>') }} />
          ))}
        </div>
      )}

      {/* center state */}
      {(buffering || state === 'loading') && !error && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-12 h-12 animate-spin text-haze-100/80" />
            {state === 'loading' && <span className="text-sm text-haze-300">Loading {source.providerName}…</span>}
          </div>
        </div>
      )}
      {blocked && !error && (
        <button onClick={togglePlay} className="absolute inset-0 grid place-items-center bg-black/40 z-20" data-testid="unblock">
          <span className="btn-primary h-14 px-8 text-base"><Play className="w-5 h-5 fill-current" /> {room ? 'Join playback' : 'Play'}</span>
        </button>
      )}
      {error && (
        <div className="absolute inset-0 z-30 grid place-items-center bg-black/80 p-6" data-testid="player-error">
          <div className="max-w-md text-center animate-fadeUp">
            <AlertTriangle className="w-10 h-10 mx-auto text-warn mb-3" />
            <h3 className="font-display text-2xl mb-2">This source didn't play</h3>
            <p className="text-haze-300 text-sm mb-5">{error}</p>
            <div className="flex flex-col gap-2">
              <button className="btn-ghost" onClick={() => props.onSourceChange({ ...source }, time)}><RotateCcw className="w-4 h-4" /> Retry</button>
              {sources.filter((s) => s.id !== source.id && s.verify.status !== 'failed').slice(0, 4).map((s) => (
                <button key={s.id} className="btn-ghost justify-between" onClick={() => props.onSourceChange(s, time)}>
                  <span className="truncate">{s.label}</span><ChevronRight className="w-4 h-4" />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* top bar */}
      <div className={cx('absolute inset-x-0 top-0 z-20 p-3 sm:p-5 flex items-start gap-3 bg-gradient-to-b from-black/80 to-transparent transition-opacity duration-300', controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none')}>
        <button className="btn-icon shrink-0" onClick={props.onBack} aria-label="Back"><ArrowLeft className="w-5 h-5" /></button>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="font-display text-lg sm:text-2xl leading-tight truncate">{detail.name}</div>
          <div className="text-xs sm:text-sm text-haze-300 truncate">
            {currentEp ? `${epCode(currentEp.season, currentEp.episode)} · ${currentEp.name}` : detail.year}
            <span className="mx-2 opacity-40">|</span>{source.providerName}
          </div>
        </div>
        {room && syncStats && (
          <div data-testid="sync-status" className={cx('hidden sm:flex items-center gap-2 glass rounded-full h-9 px-3 text-xs font-medium',
            syncStats.mode === 'locked' ? 'text-ok' : syncStats.mode === 'error' ? 'text-bad' : 'text-warn')}>
            <span className={cx('w-2 h-2 rounded-full', syncStats.mode === 'locked' ? 'bg-ok' : syncStats.mode === 'error' ? 'bg-bad' : 'bg-warn animate-pulse')} />
            {syncLabel}
            {(syncStats.mode === 'locked' || syncStats.mode === 'correcting') && <span className="text-haze-400 tabular-nums">{Math.abs(Math.round(syncStats.driftMs))} ms</span>}
          </div>
        )}
        {props.topRight}
      </div>

      {props.overlay}

      {toast && <div className="absolute left-1/2 -translate-x-1/2 top-20 z-40 glass-strong rounded-full px-4 py-2 text-sm animate-fadeUp">{toast}</div>}

      {/* up next */}
      {showUpNext && nextCountdown == null && (
        <div className="absolute right-4 bottom-28 z-20 glass-strong rounded-2xl p-3 flex gap-3 items-center max-w-xs animate-fadeUp">
          {nextEp!.thumbnail && <img src={nextEp!.thumbnail} className="w-24 aspect-video object-cover rounded-lg" alt="" />}
          <div className="min-w-0">
            <div className="label mb-1">Up next</div>
            <div className="text-sm font-semibold truncate">{nextEp!.name}</div>
            <button className="text-ember-400 text-sm font-semibold mt-1" onClick={() => (room ? props.onEpisode({ titleId: mediaRef.titleId, type: 'series', season: nextEp!.season, episode: nextEp!.episode }) : goNext())}>Play now →</button>
          </div>
        </div>
      )}
      {nextCountdown != null && nextEp && (
        <div className="absolute inset-0 z-30 grid place-items-center bg-black/70">
          <div className="text-center animate-fadeUp">
            <div className="label mb-2">Next episode in {nextCountdown}s</div>
            <div className="font-display text-3xl mb-5">{nextEp.name}</div>
            <div className="flex gap-3 justify-center">
              <button className="btn-primary" onClick={() => { setNextCountdown(null); goNext(); }}><Play className="w-4 h-4 fill-current" /> Play now</button>
              <button className="btn-ghost" onClick={() => setNextCountdown(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* bottom controls */}
      <div className={cx('absolute inset-x-0 bottom-0 z-20 px-3 sm:px-6 pb-3 sm:pb-5 pt-16 bg-gradient-to-t from-black/90 via-black/50 to-transparent transition-opacity duration-300', controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none')}>
        <div
          ref={barRef}
          data-testid="scrubber"
          className="group relative h-5 flex items-center cursor-pointer touch-none"
          onPointerMove={(e) => { const p = posFromEvent(e.clientX); setHover(p); if (scrubbing != null) setScrubbing(p.t); }}
          onPointerLeave={() => setHover(null)}
          onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); setScrubbing(posFromEvent(e.clientX).t); }}
          onPointerUp={(e) => { const t = posFromEvent(e.clientX).t; setScrubbing(null); seekTo(t); }}
        >
          <div className="relative w-full h-1 group-hover:h-1.5 transition-all rounded-full bg-white/20 overflow-hidden">
            {duration > 0 && buffered.map(([a, b], i) => (
              <div key={i} className="absolute inset-y-0 bg-white/30" style={{ left: `${(a / duration) * 100}%`, width: `${((b - a) / duration) * 100}%` }} />
            ))}
            <div className="absolute inset-y-0 left-0 bg-ember-400" style={{ width: `${progress}%` }} />
          </div>
          <div className="absolute w-3.5 h-3.5 rounded-full bg-haze-100 shadow -translate-x-1/2 scale-0 group-hover:scale-100 transition" style={{ left: `${progress}%` }} />
          {hover && duration > 0 && (
            <div className="absolute -top-8 -translate-x-1/2 glass-strong rounded-md px-2 py-0.5 text-xs tabular-nums" style={{ left: hover.x }}>{clock(hover.t)}</div>
          )}
        </div>

        <div className="mt-2 flex items-center gap-1 sm:gap-2">
          <button className="ctrl" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'} data-testid="play-toggle">
            {playing ? <Pause className="w-6 h-6 fill-current" /> : <Play className="w-6 h-6 fill-current" />}
          </button>
          <button className="ctrl hidden sm:inline-flex" onClick={() => seekTo(time - 10)} aria-label="Back 10 seconds"><RotateCcw className="w-5 h-5" /></button>
          <button className="ctrl hidden sm:inline-flex" onClick={() => seekTo(time + 10)} aria-label="Forward 10 seconds"><RotateCw className="w-5 h-5" /></button>
          {nextEp && <button className="ctrl" onClick={() => (room ? props.onEpisode({ titleId: mediaRef.titleId, type: 'series', season: nextEp.season, episode: nextEp.episode }) : goNext())} aria-label="Next episode"><SkipForward className="w-5 h-5" /></button>}
          <div className="group/vol flex items-center">
            <button className="ctrl" onClick={toggleMute} aria-label="Mute">{muted || volume === 0 ? <VolumeX className="w-5 h-5" /> : volume < 0.5 ? <Volume1 className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}</button>
            <input type="range" min={0} max={1} step={0.02} value={muted ? 0 : volume} onChange={(e) => changeVolume(Number(e.target.value))} className="slim w-0 opacity-0 group-hover/vol:w-24 group-hover/vol:opacity-100 focus:w-24 focus:opacity-100 transition-all duration-300 hidden sm:block" aria-label="Volume" />
          </div>
          <div className="text-xs sm:text-sm tabular-nums text-haze-200 ml-1" data-testid="time">{clock(shownTime)} <span className="text-haze-500">/ {clock(duration)}</span></div>
          <div className="flex-1" />
          {room && <span className="sm:hidden text-[11px] text-haze-300">{syncLabel}</span>}
          {episodes.length > 0 && <button className={cx('ctrl', menu === 'episodes' && 'bg-white/15')} onClick={() => setMenu(menu === 'episodes' ? null : 'episodes')} aria-label="Episodes"><ListVideo className="w-5 h-5" /></button>}
          <button className={cx('ctrl', menu === 'source' && 'bg-white/15')} onClick={() => setMenu(menu === 'source' ? null : 'source')} aria-label="Sources" data-testid="source-menu"><Server className="w-5 h-5" /></button>
          <button className={cx('ctrl relative', menu === 'subs' && 'bg-white/15')} onClick={() => setMenu(menu === 'subs' ? null : 'subs')} aria-label="Subtitles" data-testid="subs-menu">
            <Captions className="w-5 h-5" />{subId && <span className="absolute bottom-1.5 left-1/2 -translate-x-1/2 w-4 h-0.5 rounded bg-ember-400" />}
          </button>
          <button className={cx('ctrl', menu === 'settings' && 'bg-white/15')} onClick={() => { setSettingsPage('root'); setMenu(menu === 'settings' ? null : 'settings'); }} aria-label="Settings"><Settings2 className="w-5 h-5" /></button>
          {engineRef.current?.video && 'pictureInPictureEnabled' in document && <button className="ctrl hidden sm:inline-flex" onClick={togglePip} aria-label="Picture in picture"><PictureInPicture2 className="w-5 h-5" /></button>}
          <button className="ctrl" onClick={toggleFullscreen} aria-label="Fullscreen">{fullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}</button>
        </div>
      </div>

      {/* menus */}
      {menu && menu !== 'episodes' && (
        <div className="absolute right-3 sm:right-6 bottom-20 z-30 w-[min(92vw,340px)] max-h-[60vh] overflow-y-auto thin-scroll glass-strong rounded-2xl p-2 animate-fadeUp" onClick={(e) => e.stopPropagation()}>
          {menu === 'subs' && (
            <div>
              <div className="label px-3 pt-2 pb-1">Subtitles</div>
              <MenuItem active={!subId} onClick={() => chooseSub(null)}>Off</MenuItem>
              {externalTracks.map((t) => <MenuItem key={t.id} active={subId === t.id} onClick={() => chooseSub(t.id)} hint={t.origin}>{t.label}</MenuItem>)}
              {embedded.map((t) => <MenuItem key={t.id} active={subId === `emb:${t.id}`} onClick={() => setSubId(`emb:${t.id}`)} hint="In stream">{t.label}</MenuItem>)}
              {userSub && <MenuItem active={subId === 'user'} onClick={() => setSubId('user')} hint="Your file">{userSub.label}</MenuItem>}
              {!externalTracks.length && !embedded.length && !userSub && <div className="px-3 py-2 text-sm text-haze-400">No subtitles are available for this source.</div>}
              <label className="mx-1 mt-1 flex items-center gap-2 rounded-xl px-3 h-10 text-sm hover:bg-white/10 cursor-pointer text-haze-200">
                <Upload className="w-4 h-4" /> Load .srt / .vtt file…
                <input type="file" accept=".srt,.vtt,text/vtt" className="hidden" onChange={(e) => e.target.files?.[0] && loadUserSub(e.target.files[0])} />
              </label>
              {subId && !subId.startsWith('emb:') && (
                <div className="px-3 py-2 border-t border-white/10 mt-1 space-y-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-haze-300">Timing</span>
                    <div className="flex items-center gap-1">
                      <button className="chip h-7 px-2" onClick={() => setSubDelay((d) => +(d - 0.5).toFixed(1))}>−0.5</button>
                      <button className="chip h-7 px-2" onClick={() => setSubDelay((d) => +(d - 0.1).toFixed(1))}>−0.1</button>
                      <span className="w-14 text-center tabular-nums" data-testid="sub-delay">{subDelay > 0 ? '+' : ''}{subDelay.toFixed(1)}s</span>
                      <button className="chip h-7 px-2" onClick={() => setSubDelay((d) => +(d + 0.1).toFixed(1))}>+0.1</button>
                      <button className="chip h-7 px-2" onClick={() => setSubDelay((d) => +(d + 0.5).toFixed(1))}>+0.5</button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-haze-300">Size</span>
                    <input type="range" className="slim w-36" min={0.6} max={1.8} step={0.1} value={subSize} onChange={(e) => { setSubSize(Number(e.target.value)); savePrefs({ subtitleSize: Number(e.target.value) }); }} />
                  </div>
                </div>
              )}
            </div>
          )}
          {menu === 'source' && (
            <div>
              <div className="label px-3 pt-2 pb-1">Source {room && <span className="normal-case tracking-normal text-haze-500">· switches for everyone</span>}</div>
              {sources.map((s) => (
                <button key={s.id} onClick={() => { setMenu(null); if (s.id !== source.id) props.onSourceChange(s, time); }}
                  className={cx('w-full text-left rounded-xl px-3 py-2.5 hover:bg-white/10 flex gap-3 items-start', s.id === source.id && 'bg-white/10')}>
                  <span className={cx('mt-1.5 w-2 h-2 rounded-full shrink-0', s.verify.status === 'verified' ? 'bg-ok' : s.verify.status === 'failed' ? 'bg-bad' : 'bg-warn')} />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium truncate">{s.label}</span>
                    <span className="block text-xs text-haze-400">{s.kind.toUpperCase()} · {s.capabilities.syncGrade === 'frame' ? 'precise sync' : s.capabilities.syncGrade === 'none' ? 'no sync' : '±0.5 s sync'} · {s.subtitles.length} subs{s.adFree ? ' · ad-free' : ''}</span>
                  </span>
                  {s.id === source.id && <Check className="w-4 h-4 ml-auto mt-1 text-ember-400" />}
                </button>
              ))}
            </div>
          )}
          {menu === 'settings' && settingsPage === 'root' && (
            <div>
              <MenuItem onClick={() => setSettingsPage('quality')} icon={<Layers className="w-4 h-4" />} hint={quality === 'auto' ? 'Auto' : qualities.find((q) => q.id === quality)?.label} chevron disabled={!qualities.length}>Quality</MenuItem>
              <MenuItem onClick={() => setSettingsPage('speed')} icon={<Gauge className="w-4 h-4" />} hint={`${rate}×`} chevron disabled={source.capabilities.setPlaybackRate === false}>Speed</MenuItem>
              {!qualities.length && <div className="px-3 pb-2 text-xs text-haze-500">This source offers a single quality.</div>}
            </div>
          )}
          {menu === 'settings' && settingsPage === 'quality' && (
            <div>
              <div className="label px-3 pt-2 pb-1">Quality</div>
              {source.kind !== 'file' && <MenuItem active={quality === 'auto'} onClick={() => { setQuality('auto'); engineRef.current?.setQuality('auto'); savePrefs({ quality: 'auto' }); }}>Auto</MenuItem>}
              {qualities.map((q) => <MenuItem key={q.id} active={quality === q.id || (source.kind === 'file' && quality === 'auto' && q.id === qualities[0].id)} onClick={() => { setQuality(q.id); engineRef.current?.setQuality(q.id); savePrefs({ quality: q.id }); }}>{q.label}</MenuItem>)}
            </div>
          )}
          {menu === 'settings' && settingsPage === 'speed' && (
            <div>
              <div className="label px-3 pt-2 pb-1">Playback speed {room && <span className="normal-case tracking-normal text-haze-500">· for everyone</span>}</div>
              {RATES.map((r) => <MenuItem key={r} active={rate === r} onClick={() => changeRate(r)}>{r === 1 ? 'Normal' : `${r}×`}</MenuItem>)}
            </div>
          )}
        </div>
      )}

      {menu === 'episodes' && (
        <EpisodesDrawer detail={detail} current={currentEp} onClose={() => setMenu(null)} onPick={(ep) => { setMenu(null); props.onEpisode({ titleId: mediaRef.titleId, type: 'series', season: ep.season, episode: ep.episode }); }} />
      )}
    </div>
  );
}

function MenuItem(p: { children: ReactNode; onClick: () => void; active?: boolean; hint?: string; icon?: ReactNode; chevron?: boolean; disabled?: boolean }) {
  return (
    <button disabled={p.disabled} onClick={p.onClick} className={cx('w-full flex items-center gap-3 rounded-xl px-3 h-10 text-sm hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent', p.active && 'text-ember-300')}>
      {p.icon}
      <span className="truncate">{p.children}</span>
      <span className="ml-auto flex items-center gap-1 text-xs text-haze-400 shrink-0">{p.hint}{p.chevron && <ChevronRight className="w-4 h-4" />}{p.active && <Check className="w-4 h-4 text-ember-400" />}</span>
    </button>
  );
}

function EpisodesDrawer({ detail, current, onPick, onClose }: { detail: TitleDetail; current?: Episode; onPick: (e: Episode) => void; onClose: () => void }) {
  const seasons = detail.seasons ?? [];
  const [season, setSeason] = useState(current?.season ?? seasons.find((s) => s > 0) ?? seasons[0]);
  const list = (detail.episodes ?? []).filter((e) => e.season === season);
  return (
    <div className="absolute inset-y-0 right-0 z-30 w-full sm:w-[420px] glass-strong flex flex-col animate-fadeIn" onClick={(e) => e.stopPropagation()}>
      <div className="p-4 flex items-center gap-3 border-b border-white/10">
        <div className="font-display text-xl flex-1">Episodes</div>
        <select value={season} onChange={(e) => setSeason(Number(e.target.value))} className="input h-9 w-auto pr-8">
          {seasons.map((s) => <option key={s} value={s}>{s === 0 ? 'Specials' : `Season ${s}`}</option>)}
        </select>
        <button className="btn-icon w-9 h-9" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="flex-1 overflow-y-auto thin-scroll p-2">
        {list.map((e) => (
          <button key={e.id} disabled={e.upcoming} onClick={() => onPick(e)} className={cx('w-full flex gap-3 text-left rounded-xl p-2 hover:bg-white/10 disabled:opacity-40', current?.id === e.id && 'bg-white/10 ring-1 ring-ember-400/40')}>
            <div className="w-32 shrink-0 aspect-video rounded-lg bg-ink-700 overflow-hidden">{e.thumbnail && <img src={e.thumbnail} alt="" loading="lazy" className="w-full h-full object-cover" />}</div>
            <div className="min-w-0">
              <div className="text-xs text-haze-400">E{e.episode}{e.upcoming ? ' · upcoming' : ''}</div>
              <div className="text-sm font-semibold line-clamp-1">{e.name}</div>
              <div className="text-xs text-haze-400 line-clamp-2">{e.overview}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
