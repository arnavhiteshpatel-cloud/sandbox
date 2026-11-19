import { Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ProgressEntry, TitleSummary } from '@shared/types';
import { PosterGrid } from '../components/Grid';
import { Empty } from '../components/ui';
import { api, watchHref } from '../lib/api';
import { clock, cx, epCode, relTime } from '../lib/format';

type Tab = 'continue' | 'watchlist' | 'favorite' | 'completed' | 'history';

export default function Library() {
  const [tab, setTab] = useState<Tab>('continue');
  const [lib, setLib] = useState<{ watchlist: TitleSummary[]; favorite: TitleSummary[] } | null>(null);
  const [prog, setProg] = useState<{ continueWatching: ProgressEntry[]; completed: ProgressEntry[]; history: ProgressEntry[] } | null>(null);
  const reload = () => { api.library().then(setLib).catch(() => {}); api.progress().then(setProg).catch(() => {}); };
  useEffect(reload, []);
  const tabs: [Tab, string, number | undefined][] = [
    ['continue', 'Continue watching', prog?.continueWatching.length], ['watchlist', 'Watchlist', lib?.watchlist.length], ['favorite', 'Favorites', lib?.favorite.length],
    ['completed', 'Completed', prog?.completed.length], ['history', 'History', prog?.history.length],
  ];
  return (
    <div className="pt-28 sm:pt-24 px-4 sm:px-10">
      <h1 className="font-display text-4xl font-semibold mb-6">My List</h1>
      <div className="flex gap-2 overflow-x-auto scroll-row mb-8">
        {tabs.map(([k, l, n]) => <button key={k} className={cx('chip', tab === k && 'chip-on')} onClick={() => setTab(k)}>{l}{n ? <span className="opacity-60">{n}</span> : null}</button>)}
      </div>
      {(tab === 'continue' || tab === 'history' || tab === 'completed') && (
        <ProgressList entries={tab === 'continue' ? prog?.continueWatching : tab === 'completed' ? prog?.completed : prog?.history} onRemove={(k) => api.removeProgress(k).then(reload)} />
      )}
      {(tab === 'watchlist' || tab === 'favorite') && (lib?.[tab].length ? <PosterGrid items={lib[tab]} /> : <Empty>Nothing saved yet — use the bookmark and heart buttons on any title.</Empty>)}
    </div>
  );
}

function ProgressList({ entries, onRemove }: { entries?: ProgressEntry[]; onRemove: (key: string) => void }) {
  if (!entries) return null;
  if (!entries.length) return <Empty>Nothing here yet.</Empty>;
  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {entries.map((e) => {
        const pct = e.duration ? Math.min(100, (e.position / e.duration) * 100) : 0;
        return (
          <div key={e.mediaKey} className="group glass rounded-2xl overflow-hidden flex">
            <Link to={watchHref(e.ref, e.completed ? '' : `?t=${Math.floor(e.position)}`)} className="w-28 shrink-0 bg-ink-800">{e.title.poster && <img src={e.title.poster} alt="" className="w-full h-full object-cover" />}</Link>
            <div className="p-4 min-w-0 flex-1 flex flex-col">
              <Link to={watchHref(e.ref)} className="font-semibold truncate hover:underline">{e.title.name}</Link>
              <div className="text-xs text-haze-400 truncate">{e.ref.type === 'series' ? `${epCode(e.ref.season, e.ref.episode)} · ${e.episodeName ?? ''}` : e.title.year}</div>
              <div className="text-xs text-haze-500 mt-1">{e.completed ? 'Finished' : `${clock(e.position)} of ${clock(e.duration)}`} · {relTime(e.updatedAt)}</div>
              <div className="mt-auto pt-3 flex items-center gap-3">
                <div className="flex-1 h-1 rounded-full bg-white/10 overflow-hidden"><div className="h-full bg-ember-400" style={{ width: `${e.completed ? 100 : pct}%` }} /></div>
                <button onClick={() => onRemove(e.mediaKey)} className="text-haze-500 hover:text-bad" aria-label="Remove"><Trash2 className="w-4 h-4" /></button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
