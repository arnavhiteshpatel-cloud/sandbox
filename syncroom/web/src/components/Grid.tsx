import type { Title } from '../lib/api';
import { PosterCard, PosterSkeleton } from './PosterCard';

export function PosterGrid({ items, loading }: { items: Title[]; loading?: boolean }) {
  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 gap-x-3 sm:gap-x-4 gap-y-6" data-testid="poster-grid">
      {items.map((t) => <PosterCard key={`${t.type}-${t.id}`} t={t} />)}
      {loading && Array.from({ length: 14 }, (_, i) => <PosterSkeleton key={`s${i}`} />)}
    </div>
  );
}
