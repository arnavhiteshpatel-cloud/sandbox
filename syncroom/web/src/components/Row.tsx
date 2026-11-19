import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Title } from '../lib/api';
import { PosterCard, PosterSkeleton } from './PosterCard';
import { SectionTitle } from './ui';

export function Scroller({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const by = (d: number) => ref.current?.scrollBy({ left: d * ref.current.clientWidth * 0.85, behavior: 'smooth' });
  return (
    <div className="relative group/row">
      <div ref={ref} className="scroll-row flex gap-3 sm:gap-4 overflow-x-auto px-4 sm:px-10 pb-2 scroll-px-4 sm:scroll-px-10">{children}</div>
      <button onClick={() => by(-1)} className="hidden sm:grid absolute left-1 top-[38%] -translate-y-1/2 w-10 h-10 place-items-center rounded-full glass opacity-0 group-hover/row:opacity-100 transition" aria-label="Scroll left"><ChevronLeft /></button>
      <button onClick={() => by(1)} className="hidden sm:grid absolute right-1 top-[38%] -translate-y-1/2 w-10 h-10 place-items-center rounded-full glass opacity-0 group-hover/row:opacity-100 transition" aria-label="Scroll right"><ChevronRight /></button>
    </div>
  );
}

export function TitleRow({ title, sub, items, href, loading, ranked }: { title: string; sub?: string; items?: Title[]; href?: string; loading?: boolean; ranked?: boolean }) {
  if (!loading && (!items || items.length === 0)) return null;
  return (
    <section className="mb-9 animate-fadeUp" data-testid="row">
      <SectionTitle sub={sub} action={href && <Link to={href} className="text-sm text-haze-300 hover:text-haze-100">See all →</Link>}>{title}</SectionTitle>
      <Scroller>
        {loading
          ? Array.from({ length: 8 }, (_, i) => <PosterSkeleton key={i} className="w-[132px] sm:w-[164px]" />)
          : items!.map((t, i) => <PosterCard key={`${t.type}-${t.id}`} t={t} className="w-[132px] sm:w-[164px]" rank={ranked ? i + 1 : undefined} />)}
      </Scroller>
    </section>
  );
}
