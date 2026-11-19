import { Clapperboard, Library, Search as SearchIcon, Settings, Users, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api, titleHref, type Title } from '../lib/api';
import { cx } from '../lib/format';

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const loc = useLocation();
  useEffect(() => {
    const f = () => setScrolled(window.scrollY > 20);
    f();
    window.addEventListener('scroll', f, { passive: true });
    return () => window.removeEventListener('scroll', f);
  }, []);
  const link = ({ isActive }: { isActive: boolean }) => cx('px-3 h-9 inline-flex items-center rounded-full text-sm font-medium transition', isActive ? 'text-haze-100 bg-white/10' : 'text-haze-300 hover:text-haze-100');
  return (
    <header className={cx('fixed top-0 inset-x-0 z-50 transition-all duration-300', scrolled || loc.pathname !== '/' ? 'glass-strong border-x-0 border-t-0' : 'bg-gradient-to-b from-black/70 to-transparent')}>
      <div className="h-16 px-4 sm:px-10 flex items-center gap-2 sm:gap-6">
        <Link to="/" className="flex items-center gap-2 shrink-0" aria-label="SyncRoom home">
          <svg viewBox="0 0 64 64" className="w-8 h-8"><circle cx="26" cy="32" r="13" fill="none" stroke="#f5b971" strokeWidth="5" /><circle cx="38" cy="32" r="13" fill="none" stroke="#f4f1ea" strokeWidth="5" opacity=".9" /></svg>
          <span className="font-display text-xl font-semibold tracking-tight hidden sm:inline">SyncRoom</span>
        </Link>
        <nav className="hidden md:flex items-center gap-1">
          <NavLink to="/" end className={link}>Home</NavLink>
          <NavLink to="/browse/movie" className={link}>Movies</NavLink>
          <NavLink to="/browse/series" className={link}>Series</NavLink>
          <NavLink to="/free" className={link}>Watch Free</NavLink>
          <NavLink to="/library" className={link}>My List</NavLink>
        </nav>
        <div className="flex-1 flex justify-end"><SearchBox /></div>
        <NavLink to="/rooms" className={({ isActive }) => cx('btn-icon w-10 h-10', isActive && 'bg-white/15')} aria-label="Rooms"><Users className="w-[18px] h-[18px]" /></NavLink>
        <NavLink to="/library" className={({ isActive }) => cx('btn-icon w-10 h-10 md:hidden', isActive && 'bg-white/15')} aria-label="My list"><Library className="w-[18px] h-[18px]" /></NavLink>
        <NavLink to="/settings" className={({ isActive }) => cx('btn-icon w-10 h-10 hidden sm:inline-flex', isActive && 'bg-white/15')} aria-label="Settings"><Settings className="w-[18px] h-[18px]" /></NavLink>
      </div>
      <nav className="md:hidden flex gap-1 px-3 pb-2 overflow-x-auto scroll-row">
        <NavLink to="/browse/movie" className={link}><Clapperboard className="w-4 h-4 mr-1" />Movies</NavLink>
        <NavLink to="/browse/series" className={link}>Series</NavLink>
        <NavLink to="/free" className={link}>Watch Free</NavLink>
        <NavLink to="/settings" className={link}>Settings</NavLink>
      </nav>
    </header>
  );
}

function SearchBox() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Title[]>([]);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (q.trim().length < 2) { setItems([]); return; }
    const ctrl = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      api.suggest(q, ctrl.signal).then((r) => { setItems(r.items); setActive(-1); }).catch(() => {}).finally(() => setLoading(false));
    }, 180);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [q]);
  useEffect(() => {
    const f = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', f);
    return () => document.removeEventListener('mousedown', f);
  }, []);

  const go = (t?: Title) => {
    setOpen(false);
    if (t) nav(titleHref(t));
    else if (q.trim()) nav(`/search?q=${encodeURIComponent(q.trim())}`);
  };

  return (
    <div ref={boxRef} className="relative w-full max-w-[420px]">
      <form onSubmit={(e) => { e.preventDefault(); go(items[active]); }} className="relative">
        <SearchIcon className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-haze-400" />
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(-1, a - 1)); }
            if (e.key === 'Escape') setOpen(false);
          }}
          placeholder="Search movies & shows"
          className="w-full h-10 rounded-full bg-white/[.06] border border-white/10 pl-10 pr-9 text-sm outline-none focus:bg-white/[.09] focus:border-white/25 transition placeholder:text-haze-500"
          data-testid="search-input"
          aria-label="Search"
        />
        {q && <button type="button" onClick={() => { setQ(''); setItems([]); }} className="absolute right-3 top-1/2 -translate-y-1/2 text-haze-400 hover:text-haze-100" aria-label="Clear"><X className="w-4 h-4" /></button>}
      </form>
      {open && q.trim().length >= 2 && (
        <div className="absolute right-0 mt-2 w-[min(92vw,420px)] glass-strong rounded-2xl p-1.5 shadow-lift animate-fadeUp" data-testid="suggestions">
          {loading && !items.length && <div className="px-3 py-4 text-sm text-haze-400">Searching…</div>}
          {!loading && !items.length && <div className="px-3 py-4 text-sm text-haze-400">No matches yet — press Enter for full search.</div>}
          {items.map((t, i) => (
            <button key={t.type + t.id} onMouseEnter={() => setActive(i)} onClick={() => go(t)} className={cx('w-full flex items-center gap-3 rounded-xl p-2 text-left', i === active ? 'bg-white/10' : 'hover:bg-white/5')} data-testid="suggestion">
              <div className="w-9 h-[54px] shrink-0 rounded-md bg-ink-700 overflow-hidden">{t.poster && <img src={t.poster} alt="" className="w-full h-full object-cover" />}</div>
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{t.name}</div>
                <div className="text-xs text-haze-400">{t.type === 'series' ? 'Series' : 'Movie'}{t.releaseInfo ? ` · ${t.releaseInfo}` : ''}{t.playable ? <span className="text-ok"> · Watch now</span> : ''}</div>
              </div>
            </button>
          ))}
          {items.length > 0 && <button onClick={() => go()} className="w-full text-left px-3 py-2.5 text-sm text-ember-300 hover:bg-white/5 rounded-xl">See all results for “{q}” →</button>}
        </div>
      )}
    </div>
  );
}
