import { useEffect, useState } from 'react';
import { PosterGrid } from '../components/Grid';
import { api, type Title } from '../lib/api';

export default function Free() {
  const [items, setItems] = useState<Title[]>([]);
  const [totals, setTotals] = useState<{ titles: number; units: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    setLoading(true);
    api.free(offset, 84).then((r) => { setItems((p) => [...p, ...r.items]); setTotals(r.totals); }).finally(() => setLoading(false));
  }, [offset]);
  return (
    <div className="pt-28 sm:pt-24 px-4 sm:px-10">
      <h1 className="font-display text-4xl font-semibold mb-2">Watch Free Now</h1>
      <p className="text-haze-400 max-w-2xl mb-8">Every title here has a source SyncRoom has actually fetched and verified: public-domain classics and silent films from the Internet Archive and Blender Foundation open movies — all ad-free and frame-accurately syncable.
        {totals && <span className="block mt-2 text-haze-300" data-testid="free-totals">{totals.titles.toLocaleString()} verified titles · {totals.units.toLocaleString()} playable movies/episodes</span>}</p>
      <PosterGrid items={items} loading={loading} />
      {totals && items.length < totals.titles && !loading && <div className="text-center mt-10"><button className="btn-ghost" onClick={() => setOffset(items.length)}>Load more</button></div>}
    </div>
  );
}
