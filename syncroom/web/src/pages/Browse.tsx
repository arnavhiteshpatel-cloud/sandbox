import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { MediaType } from '@shared/types';
import { PosterGrid } from '../components/Grid';
import { Empty } from '../components/ui';
import { api, type Title } from '../lib/api';
import { cx } from '../lib/format';

const SORTS = [['popular', 'Popular'], ['new', 'New'], ['rating', 'Top rated']] as const;

export default function Browse() {
  const { type } = useParams() as { type: MediaType };
  const [params, setParams] = useSearchParams();
  const genre = params.get('genre') ?? '';
  const sort = params.get('sort') ?? 'popular';
  const year = Number(params.get('year')) || undefined;
  const [genres, setGenres] = useState<string[]>([]);
  const [items, setItems] = useState<Title[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const thisYear = new Date().getFullYear();

  useEffect(() => { api.genres(type).then((r) => setGenres(r.genres)).catch(() => {}); }, [type]);
  useEffect(() => { setItems([]); setPage(0); setHasMore(true); }, [type, genre, sort, year]);
  useEffect(() => {
    let cancel = false;
    setLoading(true);
    api.browse({ type, genre: genre || undefined, sort, year, page }).then((r) => {
      if (cancel) return;
      setItems((prev) => { const seen = new Set(prev.map((p) => p.id)); return [...prev, ...r.items.filter((i) => !seen.has(i.id))]; });
      setHasMore(r.hasMore && r.items.length > 0);
    }).catch(() => setHasMore(false)).finally(() => !cancel && setLoading(false));
    return () => { cancel = true; };
  }, [type, genre, sort, year, page]);

  const set = (k: string, v: string | undefined) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }); };

  return (
    <div className="pt-28 sm:pt-24 px-4 sm:px-10">
      <h1 className="font-display text-4xl font-semibold mb-6">{type === 'series' ? 'Series' : 'Movies'}{genre && <span className="text-haze-400"> · {genre}</span>}</h1>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {SORTS.map(([k, l]) => <button key={k} className={cx('chip', sort === k && !year && 'chip-on')} onClick={() => { set('year', undefined); set('sort', k); }}>{l}</button>)}
        <select value={year ?? ''} onChange={(e) => set('year', e.target.value || undefined)} className="input h-8 w-auto text-[13px] rounded-full py-0" aria-label="Year">
          <option value="">Any year</option>
          {Array.from({ length: thisYear - 1919 }, (_, i) => thisYear + 1 - i).map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>
      <div className="flex gap-2 overflow-x-auto scroll-row pb-4 mb-4">
        <button className={cx('chip', !genre && 'chip-on')} onClick={() => set('genre', undefined)}>All genres</button>
        {genres.map((g) => <button key={g} className={cx('chip', genre === g && 'chip-on')} onClick={() => set('genre', g)}>{g}</button>)}
      </div>
      <PosterGrid items={items} loading={loading} />
      {!loading && !items.length && <Empty>Nothing here yet.</Empty>}
      {hasMore && !loading && items.length > 0 && <div className="text-center mt-10"><button className="btn-ghost" onClick={() => setPage((p) => p + 1)}>Load more</button></div>}
    </div>
  );
}
