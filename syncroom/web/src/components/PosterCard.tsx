import { Link } from 'react-router-dom';
import { Play } from 'lucide-react';
import type { Title } from '../lib/api';
import { titleHref } from '../lib/api';
import { cx, fmtDate } from '../lib/format';

export function PosterCard({ t, className, rank }: { t: Title; className?: string; rank?: number }) {
  return (
    <Link to={titleHref(t)} className={cx('group block shrink-0 snap-start focus:outline-none', className)} data-testid="poster-card" title={t.name}>
      <div className="relative aspect-[2/3] rounded-xl overflow-hidden bg-ink-800 ring-1 ring-white/5 transition duration-300 group-hover:ring-white/25 group-hover:-translate-y-1 group-hover:shadow-lift group-focus-visible:ring-ember-400">
        {t.poster ? (
          <img src={t.poster} alt="" loading="lazy" decoding="async" className="absolute inset-0 w-full h-full object-cover transition duration-500 group-hover:scale-[1.04]" onError={(e) => ((e.target as HTMLImageElement).style.opacity = '0')} />
        ) : (
          <div className="absolute inset-0 grid place-items-center p-3 text-center font-display text-haze-300">{t.name}</div>
        )}
        <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/80 to-transparent opacity-0 group-hover:opacity-100 transition" />
        <div className="absolute top-2 left-2 flex gap-1">
          {t.playable && <span className="rounded-full bg-ok/90 text-ink-950 text-[10px] font-bold px-2 h-5 inline-flex items-center gap-1"><Play className="w-2.5 h-2.5 fill-current" />WATCH</span>}
          {t.upcoming && <span className="rounded-full bg-sky/90 text-ink-950 text-[10px] font-bold px-2 h-5 inline-flex items-center">SOON</span>}
        </div>
        {rank != null && <span className="absolute -left-1 bottom-0 font-display text-6xl font-bold text-white/90 drop-shadow-[0_2px_8px_rgba(0,0,0,.8)]">{rank}</span>}
      </div>
      <div className="mt-2 px-0.5">
        <div className="text-[13px] font-medium leading-tight line-clamp-1 text-haze-100">{t.name}</div>
        <div className="text-[12px] text-haze-400 mt-0.5 flex gap-2">
          <span>{t.upcoming && t.releaseDate ? fmtDate(t.releaseDate) : t.releaseInfo ?? t.year}</span>
          {t.rating ? <span className="text-ember-300/90">★ {t.rating.toFixed(1)}</span> : null}
          <span className="capitalize">{t.type === 'series' ? 'Series' : ''}</span>
        </div>
      </div>
    </Link>
  );
}

export function PosterSkeleton({ className }: { className?: string }) {
  return (
    <div className={cx('shrink-0', className)}>
      <div className="aspect-[2/3] rounded-xl skeleton" />
      <div className="h-3 mt-2 rounded skeleton w-3/4" />
    </div>
  );
}
