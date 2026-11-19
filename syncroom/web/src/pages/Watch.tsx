import { ArrowLeft, Link2, Loader2, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { MediaRef, MediaType, PlaybackSource, SourcesResponse, TitleDetail } from '@shared/types';
import { mediaKey } from '@shared/types';
import { NamePrompt } from '../components/ui';
import { api, titleHref, watchHref } from '../lib/api';
import { epCode } from '../lib/format';
import { displayName } from '../lib/identity';
import { Player } from '../player/Player';
import { AddSourceModal, startRoom } from './Title';

export default function Watch() {
  const p = useParams() as { type: MediaType; id: string; season?: string; episode?: string };
  const [q] = useSearchParams();
  const nav = useNavigate();
  const ref: MediaRef = useMemo(() => (p.type === 'series' ? { titleId: p.id, type: 'series', season: Number(p.season ?? 1), episode: Number(p.episode ?? 1) } : { titleId: p.id, type: 'movie' }), [p.type, p.id, p.season, p.episode]);
  const [detail, setDetail] = useState<TitleDetail | null>(null);
  const [srcs, setSrcs] = useState<SourcesResponse | null>(null);
  const [source, setSource] = useState<PlaybackSource | null>(null);
  const [startAt, setStartAt] = useState(Number(q.get('t')) || 0);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [askName, setAskName] = useState(false);

  useEffect(() => { api.title(p.type, p.id).then(setDetail).catch((e) => setError(e.message)); }, [p.type, p.id]);
  const load = () => {
    setSrcs(null); setSource(null);
    api.sources(ref).then((r) => {
      setSrcs(r);
      const wanted = q.get('source');
      const pick = r.sources.find((s) => s.id === wanted) ?? r.sources.find((s) => s.verify.status === 'verified') ?? null;
      setSource(pick);
    }).catch((e) => setError(e.message));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [mediaKey(ref)]);
  useEffect(() => {
    // resume from saved progress when no explicit time was given
    if (q.get('t')) return;
    api.titleProgress(ref.titleId).then((r) => {
      const e = r.entries.find((x) => x.mediaKey === mediaKey(ref));
      if (e && !e.completed && e.position > 10) setStartAt(e.position);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaKey(ref)]);

  const ep = detail?.episodes?.find((e) => e.season === ref.season && e.episode === ref.episode);

  if (error) return <Shell onBack={() => nav(-1)}><p className="text-haze-300">{error}</p></Shell>;
  if (!detail || !srcs) return <Shell onBack={() => nav(-1)}><Loader2 className="w-8 h-8 animate-spin text-haze-300" /><p className="text-haze-400 mt-3 text-sm">Finding a verified source…</p></Shell>;
  if (!source) {
    return (
      <Shell onBack={() => nav(titleHref({ type: p.type, id: p.id }))}>
        <div className="max-w-lg text-center">
          <div className="font-display text-3xl mb-2">{detail.name}{ep ? ` · ${epCode(ep.season, ep.episode)}` : ''}</div>
          <p className="text-haze-300 mb-6">No verified playable source was found for this {ref.type === 'series' ? 'episode' : 'title'}. SyncRoom never shows a player for content it can't actually play.</p>
          <div className="flex flex-wrap gap-2 justify-center text-xs mb-6">{srcs.checked.map((c) => <span key={c.providerId} className="chip h-7">{c.providerName}: {c.skipped ?? (c.error ? 'error' : `${c.found}`)}</span>)}</div>
          <button className="btn-accent" onClick={() => setAddOpen(true)}><Link2 className="w-4 h-4" /> Add a source for this {ref.type === 'series' ? 'episode' : 'title'}</button>
        </div>
        <AddSourceModal open={addOpen} onClose={() => setAddOpen(false)} detail={detail} fixedRef={ref} onAdded={load} />
      </Shell>
    );
  }

  return (
    <div className="fixed inset-0 bg-black">
      <Player
        key={mediaKey(ref)}
        detail={detail}
        mediaRef={ref}
        source={source}
        sources={srcs.sources}
        startAt={startAt}
        onSourceChange={(s, pos) => { setStartAt(pos); setSource({ ...s }); }}
        onEpisode={(r) => nav(watchHref(r), { replace: true })}
        onBack={() => nav(titleHref({ type: p.type, id: p.id }))}
        topRight={
          <button className="btn-ghost h-10 px-4 text-sm shrink-0" onClick={() => (displayName() ? startRoom(nav, detail, ref, startAt) : setAskName(true))}>
            <Users className="w-4 h-4" /><span className="hidden sm:inline">Watch together</span>
          </button>
        }
      />
      <NamePrompt open={askName} onCancel={() => setAskName(false)} onDone={() => { setAskName(false); startRoom(nav, detail, ref, startAt); }} />
    </div>
  );
}

function Shell({ children, onBack }: { children: React.ReactNode; onBack: () => void }) {
  return (
    <div className="fixed inset-0 bg-ink-950 grid place-items-center p-6">
      <button className="btn-icon absolute top-5 left-5" onClick={onBack} aria-label="Back"><ArrowLeft className="w-5 h-5" /></button>
      <div className="flex flex-col items-center">{children}</div>
    </div>
  );
}
