import { Bookmark, BookmarkCheck, Check, CircleSlash, Film, Heart, Link2, Loader2, Play, Plus, ShieldCheck, Users, X, Clapperboard as Youtube } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Episode, MediaRef, MediaType, PlaybackSource, ProgressEntry, SourcesResponse, TitleDetail, TitleSummary } from '@shared/types';
import { mediaKey } from '@shared/types';
import { TitleRow } from '../components/Row';
import { Empty, Modal, NamePrompt, Pill, Rating, Spinner } from '../components/ui';
import { api, watchHref, type Title as TitleT } from '../lib/api';
import { clock, cx, epCode, fmtDate } from '../lib/format';
import { displayName, store } from '../lib/identity';

export function summaryOf(d: TitleDetail): TitleSummary {
  const { people, trailers, episodes, seasons, metadataProvider, fetchedAt, ...s } = d;
  void people; void trailers; void episodes; void seasons; void metadataProvider; void fetchedAt;
  return s;
}

/** Create a room and hand the chosen media to it. */
export async function startRoom(nav: (to: string) => void, d: TitleDetail, ref: MediaRef, position = 0) {
  const { roomId, key } = await api.createRoom(`${d.name}`);
  sessionStorage.setItem(`syncroom.pendingLoad.${roomId}`, JSON.stringify({ ref, position }));
  store.set(`syncroom.room.${roomId}.key`, key);
  nav(`/room/${roomId}#k=${key}`);
}

export default function Title() {
  const { type, id } = useParams() as { type: MediaType; id: string };
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [d, setD] = useState<TitleDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [recs, setRecs] = useState<TitleT[] | null>(null);
  const [srcs, setSrcs] = useState<SourcesResponse | null>(null);
  const [srcLoading, setSrcLoading] = useState(false);
  const [progress, setProgress] = useState<ProgressEntry[]>([]);
  const [lists, setLists] = useState<{ watchlist: boolean; favorite: boolean }>({ watchlist: false, favorite: false });
  const [season, setSeason] = useState<number | null>(null);
  const [epAvail, setEpAvail] = useState<Set<string> | null>(null);
  const [trailer, setTrailer] = useState<string | null>(null);
  const [askName, setAskName] = useState<null | (() => void)>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setD(null); setErr(null); setRecs(null); setSrcs(null); setEpAvail(null); setSeason(null);
    api.title(type, id).then(setD).catch((e) => setErr(e.message));
    api.recommendations(type, id).then((r) => setRecs(r.items)).catch(() => setRecs([]));
    api.titleProgress(id).then((r) => setProgress(r.entries)).catch(() => {});
    api.library().then((r) => setLists({ watchlist: r.watchlist.some((t) => t.id === id), favorite: r.favorite.some((t) => t.id === id) })).catch(() => {});
  }, [type, id]);

  const loadSources = useCallback(() => {
    if (!d || d.type !== 'movie' || d.upcoming) return;
    setSrcLoading(true);
    api.sources({ titleId: d.id, type: 'movie' }).then(setSrcs).catch(() => setSrcs({ ref: { titleId: d.id, type: 'movie' }, sources: [], checked: [] })).finally(() => setSrcLoading(false));
  }, [d]);
  useEffect(() => { loadSources(); }, [loadSources]);
  useEffect(() => {
    if (!d || d.type !== 'series') return;
    api.episodeAvailability(d.id).then((r) => setEpAvail(new Set(r.episodes))).catch(() => setEpAvail(new Set()));
  }, [d]);

  const latest = progress[0];
  const seasons = useMemo(() => (d?.seasons ?? []).filter((s) => (d?.episodes ?? []).some((e) => e.season === s)), [d]);
  const currentSeason = season ?? latest?.ref.season ?? seasons.find((s) => s > 0) ?? seasons[0];
  const episodes = (d?.episodes ?? []).filter((e) => e.season === currentSeason);
  const epProgress = useMemo(() => new Map(progress.map((p) => [p.mediaKey, p])), [progress]);

  const playable = srcs?.sources.filter((s) => s.verify.status === 'verified') ?? [];
  const resumeEpisode: Episode | undefined = useMemo(() => {
    if (!d?.episodes) return undefined;
    if (latest?.ref.type === 'series') {
      const ep = d.episodes.find((e) => e.season === latest.ref.season && e.episode === latest.ref.episode);
      if (ep && latest.completed) { const i = d.episodes.indexOf(ep); return d.episodes.slice(i + 1).find((e) => e.season > 0 && !e.upcoming) ?? ep; }
      return ep;
    }
    const firstAvail = d.episodes.find((e) => epAvail?.has(`${e.season}:${e.episode}`));
    return firstAvail ?? d.episodes.find((e) => e.season > 0 && !e.upcoming);
  }, [d, latest, epAvail]);

  const withName = (fn: () => void) => (displayName() ? fn() : setAskName(() => fn));
  const together = (ref: MediaRef, position = 0) => withName(async () => {
    if (!d) return;
    setBusy(true);
    try { await startRoom(nav, d, ref, position); } finally { setBusy(false); }
  });
  useEffect(() => {
    if (params.get('together') === '1' && d && d.type === 'movie') together({ titleId: d.id, type: 'movie' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d]);

  const toggleList = async (list: 'watchlist' | 'favorite') => {
    if (!d) return;
    const on = lists[list];
    setLists((l) => ({ ...l, [list]: !on }));
    if (on) await api.removeFromLibrary(list, d.id); else await api.addToLibrary(list, summaryOf(d));
  };

  if (err) return <Empty><div className="pt-24">Couldn't load this title: {err}</div></Empty>;
  if (!d) return <div className="h-[80vh] grid place-items-center"><Spinner /></div>;

  const movieRef: MediaRef = { titleId: d.id, type: 'movie' };
  const resumePos = d.type === 'movie' && latest && !latest.completed ? latest.position : 0;
  const directors = d.people.filter((p) => p.role === 'director' || p.role === 'creator');
  const cast = d.people.filter((p) => p.role === 'cast');
  const writers = d.people.filter((p) => p.role === 'writer');

  return (
    <div data-testid="title-page">
      <section className="relative min-h-[88vh] flex items-end overflow-hidden pt-24">
        {d.background && <img src={d.background} alt="" className="absolute inset-0 w-full h-full object-cover animate-fadeIn" />}
        <div className="absolute inset-0 scrim-l" />
        <div className="absolute inset-0 scrim-b" />
        <div className="relative w-full px-4 sm:px-10 pb-12 pt-32 flex gap-10 items-end">
          {d.poster && <img src={d.poster} alt="" className="hidden lg:block w-56 rounded-2xl shadow-lift ring-1 ring-white/10 animate-fadeUp" />}
          <div className="max-w-3xl animate-fadeUp">
            <div className="flex flex-wrap gap-2 mb-4">
              <Pill>{d.type === 'series' ? 'Series' : 'Film'}</Pill>
              {d.upcoming && <Pill tone="warn">Coming {fmtDate(d.releaseDate) || d.releaseInfo} · not yet watchable</Pill>}
              {d.type === 'movie' && !d.upcoming && (srcLoading ? <Pill><Loader2 className="w-3 h-3 animate-spin" />Checking sources…</Pill> : playable.length ? <Pill tone="ok"><ShieldCheck className="w-3 h-3" />{playable.length} verified source{playable.length > 1 ? 's' : ''}</Pill> : srcs ? <Pill tone="neutral"><CircleSlash className="w-3 h-3" />No playable source found</Pill> : null)}
              {d.type === 'series' && epAvail && epAvail.size > 0 && <Pill tone="ok"><ShieldCheck className="w-3 h-3" />{epAvail.size} episode{epAvail.size > 1 ? 's' : ''} playable</Pill>}
            </div>
            {d.logo ? <img src={d.logo} alt={d.name} className="max-h-24 sm:max-h-32 w-auto max-w-[85%] object-contain object-left mb-5 [filter:drop-shadow(0_2px_14px_rgba(0,0,0,.7))_drop-shadow(0_0_1.5px_rgba(255,255,255,.55))]" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden'); }} /> : null}
            <h1 className={cx('font-display text-4xl sm:text-6xl font-semibold tracking-tight mb-4', d.logo && 'hidden')}>{d.name}</h1>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-haze-200 mb-4">
              <Rating value={d.rating} />
              <span>{d.releaseInfo ?? d.year}</span>
              {d.runtime && <span>{d.runtime}</span>}
              {d.type === 'series' && seasons.filter((s) => s > 0).length > 0 && <span>{seasons.filter((s) => s > 0).length} season{seasons.filter((s) => s > 0).length > 1 ? 's' : ''}</span>}
              {d.genres?.map((g) => <Link key={g} to={`/browse/${d.type}?genre=${encodeURIComponent(g)}`} className="text-haze-400 hover:text-haze-100">{g}</Link>)}
            </div>
            <p className="text-haze-200/90 leading-relaxed max-w-2xl mb-6">{d.description}</p>
            <div className="flex flex-wrap gap-3">
              {d.type === 'movie' && !d.upcoming && (
                playable.length ? (
                  <Link to={watchHref(movieRef, resumePos ? `?t=${Math.floor(resumePos)}` : '')} className="btn-primary" data-testid="watch-btn">
                    <Play className="w-4 h-4 fill-current" />{resumePos ? `Resume ${clock(resumePos)}` : 'Play'}
                  </Link>
                ) : (
                  <button className="btn-primary" disabled>{srcLoading ? <><Loader2 className="w-4 h-4 animate-spin" />Finding sources</> : <><Play className="w-4 h-4" />Unavailable</>}</button>
                )
              )}
              {d.type === 'series' && resumeEpisode && (
                <Link to={watchHref({ titleId: d.id, type: 'series', season: resumeEpisode.season, episode: resumeEpisode.episode }, latest?.ref.type === 'series' && !latest.completed ? `?t=${Math.floor(latest.position)}` : '')} className="btn-primary" data-testid="watch-btn">
                  <Play className="w-4 h-4 fill-current" />{latest ? 'Continue' : 'Play'} {epCode(resumeEpisode.season, resumeEpisode.episode)}
                </Link>
              )}
              {!d.upcoming && (
                <button className="btn-accent" data-testid="together-btn" disabled={busy || (d.type === 'movie' && !playable.length && !srcLoading)}
                  onClick={() => together(d.type === 'movie' ? movieRef : { titleId: d.id, type: 'series', season: resumeEpisode?.season ?? 1, episode: resumeEpisode?.episode ?? 1 }, resumePos)}>
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Users className="w-4 h-4" />} Watch together
                </button>
              )}
              {d.trailers[0] && <button className="btn-ghost" onClick={() => setTrailer(d.trailers[0].ytId)}><Youtube className="w-4 h-4" /> Trailer</button>}
              <button className="btn-icon" onClick={() => toggleList('watchlist')} aria-label="Watchlist" title={lists.watchlist ? 'Remove from watchlist' : 'Add to watchlist'} data-testid="watchlist-btn">
                {lists.watchlist ? <BookmarkCheck className="w-5 h-5 text-ember-400" /> : <Bookmark className="w-5 h-5" />}
              </button>
              <button className="btn-icon" onClick={() => toggleList('favorite')} aria-label="Favorite" title="Favorite" data-testid="favorite-btn">
                <Heart className={cx('w-5 h-5', lists.favorite && 'fill-ember-400 text-ember-400')} />
              </button>
            </div>
          </div>
        </div>
      </section>

      <div className="px-4 sm:px-10 grid lg:grid-cols-[1fr_360px] gap-10 mt-4">
        <div className="min-w-0">
          {d.type === 'movie' && !d.upcoming && (
            <SourcesPanel srcs={srcs} loading={srcLoading} onAdd={() => setAddOpen(true)} watchRef={movieRef} resumePos={resumePos} />
          )}

          {d.type === 'series' && (
            <section className="mb-12" data-testid="episodes">
              <div className="flex items-center gap-3 mb-4 flex-wrap">
                <h2 className="font-display text-2xl font-semibold mr-2">Episodes</h2>
                <div className="flex gap-1.5 overflow-x-auto scroll-row max-w-full">
                  {seasons.map((s) => (
                    <button key={s} onClick={() => setSeason(s)} className={cx('chip', s === currentSeason && 'chip-on')}>{s === 0 ? 'Specials' : `Season ${s}`}</button>
                  ))}
                </div>
              </div>
              {!episodes.length && <Empty>No episode information yet.</Empty>}
              <div className="grid gap-3">
                {episodes.map((e) => {
                  const ref: MediaRef = { titleId: d.id, type: 'series', season: e.season, episode: e.episode };
                  const p = epProgress.get(mediaKey(ref));
                  const avail = epAvail?.has(`${e.season}:${e.episode}`);
                  return (
                    <div key={e.id} className="group flex gap-4 rounded-2xl p-2.5 hover:bg-white/[.04] transition" data-testid="episode">
                      <Link to={e.upcoming ? '#' : watchHref(ref, p && !p.completed ? `?t=${Math.floor(p.position)}` : '')} className="relative w-40 sm:w-56 shrink-0 aspect-video rounded-xl overflow-hidden bg-ink-800 ring-1 ring-white/5">
                        {e.thumbnail ? <img src={e.thumbnail} alt="" loading="lazy" className="w-full h-full object-cover" onError={(ev) => ((ev.target as HTMLImageElement).style.opacity = '0')} /> : <Film className="absolute inset-0 m-auto w-8 h-8 text-haze-500" />}
                        {!e.upcoming && <span className="absolute inset-0 grid place-items-center opacity-0 group-hover:opacity-100 transition bg-black/30"><Play className="w-8 h-8 fill-white" /></span>}
                        {p && <div className="absolute inset-x-0 bottom-0 h-1 bg-white/20"><div className="h-full bg-ember-400" style={{ width: `${p.completed ? 100 : Math.min(100, (p.position / (p.duration || 1)) * 100)}%` }} /></div>}
                      </Link>
                      <div className="min-w-0 flex-1 py-1">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className="text-xs text-haze-400 tabular-nums">E{e.episode}</span>
                          <span className="font-semibold truncate">{e.name}</span>
                          {p?.completed && <Check className="w-4 h-4 text-ok" />}
                          {e.upcoming ? <Pill tone="warn">Airs {fmtDate(e.released)}</Pill> : avail ? <Pill tone="ok">Playable</Pill> : null}
                        </div>
                        <div className="text-xs text-haze-500 mb-1.5">{fmtDate(e.released)}{e.rating ? ` · ★ ${e.rating}` : ''}</div>
                        <p className="text-sm text-haze-300 line-clamp-2">{e.overview}</p>
                        {!e.upcoming && (
                          <div className="mt-2 flex gap-2 opacity-100 sm:opacity-0 group-hover:opacity-100 transition">
                            <button className="chip" onClick={() => together(ref, p && !p.completed ? p.position : 0)}><Users className="w-3.5 h-3.5" /> Together</button>
                            <button className="chip" onClick={() => setAddOpen(true)}><Link2 className="w-3.5 h-3.5" /> Add source</button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {epAvail && epAvail.size === 0 && (
                <p className="text-sm text-haze-400 mt-4">No playable episodes were found in your media folder, media servers, added links or public-domain libraries. Episodes are still browsable; add a source to watch.</p>
              )}
            </section>
          )}

          {cast.length > 0 && (
            <section className="mb-12">
              <h2 className="font-display text-2xl font-semibold mb-4">Cast</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {cast.slice(0, 16).map((p) => (
                  <Link key={p.name} to={`/search?q=${encodeURIComponent(p.name)}`} className="flex items-center gap-3 rounded-xl p-2 hover:bg-white/[.04]">
                    {p.photo ? <img src={p.photo} alt="" className="w-11 h-11 rounded-full object-cover" /> : <div className="w-11 h-11 rounded-full bg-gradient-to-br from-ink-600 to-ink-800 grid place-items-center text-sm font-semibold text-haze-300">{p.name.split(' ').map((x) => x[0]).slice(0, 2).join('')}</div>}
                    <div className="min-w-0"><div className="text-sm font-medium truncate">{p.name}</div>{p.character && <div className="text-xs text-haze-400 truncate">{p.character}</div>}</div>
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>

        <aside className="space-y-6 text-sm">
          <div className="glass rounded-2xl p-5 space-y-4">
            {directors.length > 0 && <Fact label={directors[0].role === 'creator' ? 'Created by' : 'Directed by'}>{directors.map((p) => p.name).join(', ')}</Fact>}
            {writers.length > 0 && <Fact label="Written by">{writers.map((p) => p.name).join(', ')}</Fact>}
            {d.releaseDate && <Fact label={d.upcoming ? 'Release date' : 'Released'}>{fmtDate(d.releaseDate)}</Fact>}
            {d.country && <Fact label="Country">{d.country}</Fact>}
            {d.status && <Fact label="Status">{d.status}</Fact>}
            {d.awards && <Fact label="Awards">{d.awards}</Fact>}
            {d.imdbId && <Fact label="IMDb"><a className="text-ember-300 hover:underline" href={`https://www.imdb.com/title/${d.imdbId}/`} target="_blank" rel="noreferrer">{d.imdbId}</a></Fact>}
          </div>
          {d.trailers.length > 1 && (
            <div className="glass rounded-2xl p-5">
              <div className="label mb-3">Trailers</div>
              <div className="space-y-2">{d.trailers.slice(0, 4).map((t, i) => <button key={t.ytId + i} className="w-full text-left flex items-center gap-2 text-haze-200 hover:text-white" onClick={() => setTrailer(t.ytId)}><Youtube className="w-4 h-4 text-bad" />{t.name || `Trailer ${i + 1}`}</button>)}</div>
            </div>
          )}
        </aside>
      </div>

      <div className="mt-6"><TitleRow title="More Like This" items={recs ?? undefined} loading={!recs} /></div>

      <Modal open={!!trailer} onClose={() => setTrailer(null)} wide>
        <div className="relative aspect-video rounded-3xl overflow-hidden">
          {trailer && <iframe className="absolute inset-0 w-full h-full" src={`https://www.youtube-nocookie.com/embed/${trailer}?autoplay=1&rel=0&modestbranding=1`} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" title="Trailer" />}
          <button className="absolute top-3 right-3 btn-icon w-9 h-9" onClick={() => setTrailer(null)} aria-label="Close"><X className="w-4 h-4" /></button>
        </div>
      </Modal>
      <NamePrompt open={!!askName} onCancel={() => setAskName(null)} onDone={() => { const f = askName; setAskName(null); f?.(); }} />
      <AddSourceModal open={addOpen} onClose={() => setAddOpen(false)} detail={d} season={currentSeason} onAdded={() => { loadSources(); if (d.type === 'series') api.episodeAvailability(d.id).then((r) => setEpAvail(new Set(r.episodes))); }} />
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><div className="label mb-1">{label}</div><div className="text-haze-200">{children}</div></div>;
}

function SourcesPanel({ srcs, loading, onAdd, watchRef, resumePos }: { srcs: SourcesResponse | null; loading: boolean; onAdd: () => void; watchRef: MediaRef; resumePos: number }) {
  return (
    <section className="mb-12" data-testid="sources-panel">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="font-display text-2xl font-semibold">Where to watch</h2>
        <button className="chip ml-auto" onClick={onAdd}><Plus className="w-3.5 h-3.5" /> Add a source</button>
      </div>
      {loading && <div className="glass rounded-2xl p-6 flex items-center gap-3 text-haze-300"><Loader2 className="w-5 h-5 animate-spin" />Checking your media, servers and public libraries — every source is test-fetched before it's shown as playable…</div>}
      {!loading && srcs && srcs.sources.length === 0 && (
        <div className="glass rounded-2xl p-6 text-haze-300 text-sm leading-relaxed">
          <div className="font-semibold text-haze-100 mb-1">No playable source for this title yet.</div>
          SyncRoom only plays media from sources you're entitled to: your own files, your Jellyfin/Plex server, links you add, open movies and public-domain libraries.
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            {srcs.checked.map((c) => <span key={c.providerId} className="chip h-7">{c.providerName}: {c.skipped ?? (c.error ? 'error' : `${c.found} found`)}</span>)}
          </div>
        </div>
      )}
      {!loading && srcs && srcs.sources.length > 0 && (
        <div className="grid gap-2">
          {srcs.sources.map((s) => <SourceRow key={s.id} s={s} watchRef={watchRef} resumePos={resumePos} />)}
        </div>
      )}
    </section>
  );
}

function SourceRow({ s, watchRef, resumePos }: { s: PlaybackSource; watchRef: MediaRef; resumePos: number }) {
  const ok = s.verify.status === 'verified';
  return (
    <div className="glass rounded-2xl p-4 flex items-center gap-4" data-testid="source-row">
      <span className={cx('w-2.5 h-2.5 rounded-full shrink-0', ok ? 'bg-ok' : s.verify.status === 'failed' ? 'bg-bad' : 'bg-warn')} />
      <div className="min-w-0 flex-1">
        <div className="font-medium truncate">{s.label}</div>
        <div className="text-xs text-haze-400 flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
          <span>{s.kind.toUpperCase()}</span>
          <span>{s.capabilities.syncGrade === 'frame' ? 'Frame-accurate sync' : s.capabilities.syncGrade === 'none' ? 'Cannot sync' : 'Seek-based sync'}</span>
          {s.subtitles.length > 0 && <span>{s.subtitles.length} subtitle track{s.subtitles.length > 1 ? 's' : ''}</span>}
          {s.qualities.length > 1 && <span>{s.qualities.map((q) => q.label).join(' / ')}</span>}
          {s.durationSec ? <span>{clock(s.durationSec)}</span> : null}
          <span title={s.verify.detail}>{ok ? 'Verified' : s.verify.status === 'failed' ? `Failed: ${s.verify.detail}` : 'Unverified'}</span>
        </div>
        {(s.license || s.notes) && <div className="text-[11px] text-haze-500 mt-1 truncate" title={`${s.license ?? ''} ${s.notes ?? ''}`}>{s.license}{s.notes ? ` · ${s.notes}` : ''}</div>}
      </div>
      {ok && <Link to={watchHref(watchRef, `?source=${encodeURIComponent(s.id)}${resumePos ? `&t=${Math.floor(resumePos)}` : ''}`)} className="btn-ghost h-9 px-4 text-sm"><Play className="w-3.5 h-3.5 fill-current" /> Play</Link>}
    </div>
  );
}

export function AddSourceModal({ open, onClose, detail, season, onAdded, fixedRef }: { open: boolean; onClose: () => void; detail: TitleDetail; season?: number; onAdded: () => void; fixedRef?: MediaRef }) {
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [sub, setSub] = useState('');
  const [ep, setEp] = useState<string>(fixedRef?.episode != null ? `${fixedRef.season}:${fixedRef.episode}` : '');
  const [state, setState] = useState<{ busy?: boolean; msg?: string; ok?: boolean }>({});
  const eps = (detail.episodes ?? []).filter((e) => season == null || e.season === season || fixedRef);
  const submit = async () => {
    const [s, e] = ep.split(':').map(Number);
    const ref: MediaRef = detail.type === 'series' ? { titleId: detail.id, type: 'series', season: s, episode: e } : { titleId: detail.id, type: 'movie' };
    if (detail.type === 'series' && !ep) { setState({ msg: 'Choose an episode' }); return; }
    setState({ busy: true });
    try {
      const r = await api.addSource({ titleId: detail.id, mediaKey: mediaKey(ref), url, label, subtitles: sub ? [{ url: sub, lang: 'en' }] : [] });
      setState({ ok: r.verify.status === 'verified', msg: r.verify.status === 'verified' ? `Verified: ${r.verify.detail}` : `Saved, but verification failed: ${r.verify.detail}` });
      onAdded();
    } catch (err) {
      setState({ msg: (err as Error).message });
    }
  };
  return (
    <Modal open={open} onClose={onClose}>
      <div className="p-7">
        <div className="font-display text-2xl mb-1">Add a source</div>
        <p className="text-sm text-haze-400 mb-5">Attach a video you have the right to play: a direct MP4/WebM file, an HLS (.m3u8) or DASH (.mpd) stream, or a YouTube/Vimeo link. It's test-fetched before it's marked playable.</p>
        {detail.type === 'series' && !fixedRef && (
          <select className="input mb-3" value={ep} onChange={(e) => setEp(e.target.value)}>
            <option value="">Choose episode…</option>
            {eps.map((e) => <option key={e.id} value={`${e.season}:${e.episode}`}>{epCode(e.season, e.episode)} · {e.name}</option>)}
          </select>
        )}
        <input className="input mb-3" placeholder="https://…/video.mp4 or .m3u8" value={url} onChange={(e) => setUrl(e.target.value)} data-testid="add-source-url" />
        <input className="input mb-3" placeholder="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <input className="input mb-4" placeholder="Subtitle URL .srt/.vtt (optional)" value={sub} onChange={(e) => setSub(e.target.value)} />
        {state.msg && <div className={cx('text-sm mb-4', state.ok ? 'text-ok' : 'text-warn')} data-testid="add-source-result">{state.msg}</div>}
        <div className="flex gap-2">
          <button className="btn-ghost flex-1" onClick={onClose}>Close</button>
          <button className="btn-accent flex-1" disabled={!url || state.busy} onClick={submit}>{state.busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Verify & add'}</button>
        </div>
      </div>
    </Modal>
  );
}
