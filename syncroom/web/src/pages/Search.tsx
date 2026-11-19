import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PosterGrid } from '../components/Grid';
import { Empty } from '../components/ui';
import { api, type Title } from '../lib/api';
import { cx } from '../lib/format';

export default function Search() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const type = params.get('type') ?? '';
  const genre = params.get('genre') ?? '';
  const decade = params.get('decade') ?? '';
  const minRating = params.get('minRating') ?? '';
  const playable = params.get('playable') === '1';
  const [items, setItems] = useState<Title[] | null>(null);
  const [input, setInput] = useState(q);
  useEffect(() => setInput(q), [q]);
  useEffect(() => {
    if (!q.trim()) { setItems([]); return; }
    setItems(null);
    const yearFrom = decade ? Number(decade) : undefined;
    api.search({ q, type: type || undefined, genre: genre || undefined, yearFrom, yearTo: yearFrom ? yearFrom + 9 : undefined, minRating: minRating || undefined, playable: playable ? 1 : undefined })
      .then((r) => setItems(r.items)).catch(() => setItems([]));
  }, [q, type, genre, decade, minRating, playable]);
  const set = (k: string, v?: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }); };
  const allGenres = [...new Set((items ?? []).flatMap((i) => i.genres ?? []))].sort();
  const decades = Array.from({ length: 11 }, (_, i) => 2020 - i * 10);
  return (
    <div className="pt-28 sm:pt-24 px-4 sm:px-10">
      <form onSubmit={(e) => { e.preventDefault(); set('q', input.trim()); }} className="mb-6">
        <input autoFocus value={input} onChange={(e) => setInput(e.target.value)} placeholder="Search titles, people…" className="w-full bg-transparent border-b border-white/15 focus:border-ember-400 outline-none font-display text-3xl sm:text-5xl py-3 placeholder:text-haze-500" data-testid="search-page-input" />
      </form>
      <div className="flex flex-wrap gap-2 mb-8 items-center">
        {[['', 'All'], ['movie', 'Movies'], ['series', 'Series']].map(([k, l]) => <button key={k} className={cx('chip', type === k && 'chip-on')} onClick={() => set('type', k || undefined)}>{l}</button>)}
        <span className="w-px h-6 bg-white/10 mx-1" />
        <select className="input h-8 w-auto rounded-full text-[13px] py-0" value={decade} onChange={(e) => set('decade', e.target.value || undefined)} aria-label="Decade">
          <option value="">Any decade</option>{decades.map((d) => <option key={d} value={d}>{d}s</option>)}
        </select>
        <select className="input h-8 w-auto rounded-full text-[13px] py-0" value={genre} onChange={(e) => set('genre', e.target.value || undefined)} aria-label="Genre">
          <option value="">Any genre</option>{allGenres.map((g) => <option key={g}>{g}</option>)}
        </select>
        <select className="input h-8 w-auto rounded-full text-[13px] py-0" value={minRating} onChange={(e) => set('minRating', e.target.value || undefined)} aria-label="Rating">
          <option value="">Any rating</option>{[9, 8, 7, 6].map((r) => <option key={r} value={r}>★ {r}+</option>)}
        </select>
        <button className={cx('chip', playable && 'chip-on')} onClick={() => set('playable', playable ? undefined : '1')} data-testid="filter-playable">Playable now</button>
      </div>
      {q && items && <div className="text-sm text-haze-400 mb-4">{items.length} result{items.length === 1 ? '' : 's'} for “{q}”</div>}
      <PosterGrid items={items ?? []} loading={items === null} />
      {items && !items.length && q && <Empty>No titles match. Try fewer filters{playable ? ' or turn off “Playable now”' : ''}.</Empty>}
      {!q && <Empty>Search the full catalogue — Hollywood, world cinema, classics, series and upcoming releases.</Empty>}
    </div>
  );
}
