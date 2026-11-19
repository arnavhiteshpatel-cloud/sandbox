import { Play, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CatalogSection, ProgressEntry, TitleSummary } from '@shared/types';
import { Hero } from '../components/Hero';
import { Scroller, TitleRow } from '../components/Row';
import { SectionTitle } from '../components/ui';
import { api, watchHref, type Title } from '../lib/api';
import { epCode } from '../lib/format';

export default function Home() {
  const [sections, setSections] = useState<CatalogSection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressEntry[]>([]);
  const [free, setFree] = useState<Title[]>([]);
  const [watchlist, setWatchlist] = useState<TitleSummary[]>([]);

  useEffect(() => {
    api.home().then((r) => setSections(r.sections)).catch((e) => setError(e.message));
    api.progress().then((r) => setProgress(r.continueWatching)).catch(() => {});
    api.free(0, 30).then((r) => setFree(r.items)).catch(() => {});
    api.library().then((r) => setWatchlist(r.watchlist)).catch(() => {});
  }, []);

  const featured = (sections?.find((s) => s.id === 'trending-movies')?.items ?? []).filter((t) => t.background && t.description).slice(0, 6);

  return (
    <div>
      <Hero items={featured} />
      <div className="-mt-10 relative z-10">
        {progress.length > 0 && <ContinueRow items={progress} onRemove={(k) => { api.removeProgress(k); setProgress((p) => p.filter((x) => x.ref.titleId !== k)); }} />}
        <TitleRow title="Watch Free Now" sub="Verified playable · public domain & open movies, ad-free" items={free} href="/free" />
        {watchlist.length > 0 && <TitleRow title="My Watchlist" items={watchlist} href="/library" />}
        {error && <div className="mx-4 sm:mx-10 my-10 glass rounded-2xl p-6 text-haze-300">Could not load the catalogue ({error}). Check your internet connection — SyncRoom will retry automatically on reload.</div>}
        {!sections && !error && Array.from({ length: 4 }, (_, i) => <TitleRow key={i} title=" " loading />)}
        {sections?.map((s) => <TitleRow key={s.id} title={s.title} sub={s.subtitle} items={s.items} href={s.href} ranked={s.id === 'trending-movies'} />)}
      </div>
    </div>
  );
}

function ContinueRow({ items, onRemove }: { items: ProgressEntry[]; onRemove: (titleId: string) => void }) {
  return (
    <section className="mb-9" data-testid="continue-watching">
      <SectionTitle>Continue Watching</SectionTitle>
      <Scroller>
        {items.map((e) => {
          const pct = e.duration ? Math.min(100, (e.position / e.duration) * 100) : 0;
          const img = e.title.background ?? e.title.poster;
          return (
            <div key={e.mediaKey} className="group relative shrink-0 w-[260px] sm:w-[320px] snap-start">
              <Link to={watchHref(e.ref, `?t=${Math.floor(e.position)}`)} className="block">
                <div className="relative aspect-video rounded-xl overflow-hidden bg-ink-800 ring-1 ring-white/5 group-hover:ring-white/25 transition">
                  {img && <img src={img} alt="" loading="lazy" className="w-full h-full object-cover transition duration-500 group-hover:scale-[1.04]" />}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/10 to-transparent" />
                  <div className="absolute inset-0 grid place-items-center opacity-0 group-hover:opacity-100 transition"><span className="w-12 h-12 rounded-full bg-white/90 text-ink-950 grid place-items-center"><Play className="w-5 h-5 fill-current ml-0.5" /></span></div>
                  <div className="absolute left-3 right-3 bottom-3">
                    <div className="text-sm font-semibold truncate">{e.title.name}</div>
                    <div className="text-xs text-haze-300 truncate">{e.ref.type === 'series' ? `${epCode(e.ref.season, e.ref.episode)} · ${e.episodeName ?? ''}` : `${Math.max(1, Math.round((e.duration - e.position) / 60))} min left`}</div>
                    <div className="mt-2 h-1 rounded-full bg-white/20 overflow-hidden"><div className="h-full bg-ember-400" style={{ width: `${pct}%` }} /></div>
                  </div>
                </div>
              </Link>
              <button onClick={() => onRemove(e.ref.titleId)} className="absolute top-2 right-2 w-7 h-7 grid place-items-center rounded-full glass opacity-0 group-hover:opacity-100 transition" aria-label="Remove from continue watching"><X className="w-3.5 h-3.5" /></button>
            </div>
          );
        })}
      </Scroller>
    </section>
  );
}
