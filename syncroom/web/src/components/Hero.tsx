import { Info, Play, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { titleHref, type Title } from '../lib/api';
import { cx } from '../lib/format';
import { Rating } from './ui';

export function Hero({ items }: { items: Title[] }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (items.length < 2) return;
    const t = setInterval(() => setI((x) => (x + 1) % items.length), 9000);
    return () => clearInterval(t);
  }, [items.length]);
  if (!items.length) return <div className="h-[78vh] skeleton" />;
  const t = items[i];
  return (
    <section className="relative h-[78vh] min-h-[520px] max-h-[860px] overflow-hidden" data-testid="hero">
      {items.map((x, k) => (
        <img key={x.id} src={x.background} alt="" className={cx('absolute inset-0 w-full h-full object-cover transition-opacity duration-[1200ms]', k === i ? 'opacity-100 animate-kenburns' : 'opacity-0')} />
      ))}
      <div className="absolute inset-0 scrim-l" />
      <div className="absolute inset-0 scrim-b" />
      <div key={t.id} className="relative h-full flex flex-col justify-end px-4 sm:px-10 pb-16 sm:pb-24 max-w-3xl animate-fadeUp">
        <div className="label text-ember-300 mb-3">Featured {t.type === 'series' ? 'series' : 'film'}</div>
        {t.logo ? (
          <img src={t.logo} alt={t.name} className="max-h-28 sm:max-h-36 max-w-[80%] object-contain object-left mb-5 drop-shadow-2xl" onError={(e) => ((e.target as HTMLImageElement).replaceWith(Object.assign(document.createElement('h1'), { className: 'font-display text-5xl font-semibold mb-4', textContent: t.name })))} />
        ) : (
          <h1 className="font-display text-4xl sm:text-6xl font-semibold tracking-tight mb-4">{t.name}</h1>
        )}
        <div className="flex items-center gap-3 text-sm text-haze-200 mb-3">
          <Rating value={t.rating} />
          <span>{t.releaseInfo ?? t.year}</span>
          {t.runtime && <span>{t.runtime}</span>}
          {t.genres?.slice(0, 3).map((g) => <span key={g} className="text-haze-400">{g}</span>)}
        </div>
        <p className="text-haze-200/90 text-[15px] leading-relaxed line-clamp-3 mb-6 max-w-xl">{t.description}</p>
        <div className="flex flex-wrap gap-3">
          <Link to={titleHref(t)} className="btn-primary"><Play className="w-4 h-4 fill-current" /> {t.playable ? 'Watch' : 'Details & sources'}</Link>
          <Link to={`${titleHref(t)}?together=1`} className="btn-ghost"><Users className="w-4 h-4" /> Watch together</Link>
          <Link to={titleHref(t)} className="btn-ghost hidden sm:inline-flex"><Info className="w-4 h-4" /> More info</Link>
        </div>
      </div>
      <div className="absolute bottom-8 right-6 sm:right-10 flex gap-1.5">
        {items.map((x, k) => <button key={x.id} onClick={() => setI(k)} className={cx('h-1.5 rounded-full transition-all', k === i ? 'w-6 bg-haze-100' : 'w-1.5 bg-white/30')} aria-label={`Show ${x.name}`} />)}
      </div>
    </section>
  );
}
