import { CheckCircle2, CircleDashed, FolderOpen, Keyboard, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ProviderInfo } from '@shared/types';
import { Pill } from '../components/ui';
import { api } from '../lib/api';
import { cx, relTime } from '../lib/format';
import { displayName, setDisplayName } from '../lib/identity';

type P = ProviderInfo & { config: Record<string, unknown> };

export default function Settings() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.providers>> | null>(null);
  const [name, setName] = useState(displayName() ?? '');
  const [saved, setSaved] = useState(false);
  const [tmdb, setTmdb] = useState('');
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.stats>> | null>(null);
  const [local, setLocal] = useState<Awaited<ReturnType<typeof api.localLibrary>> | null>(null);
  const [checking, setChecking] = useState(false);
  const reload = () => { api.providers().then(setData); api.stats().then(setStats); api.localLibrary().then(setLocal); };
  useEffect(reload, []);

  return (
    <div className="pt-28 sm:pt-24 px-4 sm:px-10 max-w-5xl">
      <h1 className="font-display text-4xl font-semibold mb-8">Settings</h1>

      <Section title="You">
        <form className="flex gap-2 max-w-md" onSubmit={(e) => { e.preventDefault(); setDisplayName(name); setSaved(true); setTimeout(() => setSaved(false), 1500); }}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name" />
          <button className="btn-primary shrink-0">{saved ? 'Saved' : 'Save'}</button>
        </form>
        <p className="text-xs text-haze-500 mt-2">No account: your identity is a random id stored in this browser. Watch history, lists and room access are tied to it.</p>
      </Section>

      <Section title="Catalogue metadata">
        {data && (
          <div className="space-y-3">
            <div className="text-sm">Active provider: <span className="text-haze-100 font-medium">{data.metadata.name}</span></div>
            <div className="text-xs text-haze-500">{data.metadata.attribution}</div>
            <form className="flex gap-2 max-w-xl" onSubmit={(e) => { e.preventDefault(); api.saveTmdb(tmdb).then(reload); }}>
              <input className="input" type="password" placeholder={data.metadata.tmdbConfigured ? 'TMDB key configured — paste a new one to replace' : 'TMDB API key or read access token (optional)'} value={tmdb} onChange={(e) => setTmdb(e.target.value)} />
              <button className="btn-ghost shrink-0">Save</button>
            </form>
            <p className="text-xs text-haze-500">With a free TMDB key you get cast photos, localized recommendations and origin-country shelves. Without one, SyncRoom uses the keyless IMDb-keyed Cinemeta catalogue.</p>
          </div>
        )}
      </Section>

      <Section title="Playback sources" action={<button className="chip" disabled={checking} onClick={() => { setChecking(true); api.checkHealth().then(reload).finally(() => setChecking(false)); }}>{checking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Check health</button>}>
        {stats && <div className="text-sm text-haze-300 mb-4" data-testid="stats">Verified playable so far: <b className="text-haze-100">{stats.playable.titles.toLocaleString()}</b> titles / <b className="text-haze-100">{stats.playable.units.toLocaleString()}</b> movies & episodes ({stats.byProvider.map((b) => `${b.provider}: ${b.units}`).join(', ') || 'none yet'}) · {stats.localFiles} local files</div>}
        <div className="grid gap-3">{data?.providers.map((p) => <ProviderCard key={p.id} p={p} onSaved={reload} />)}</div>
      </Section>

      <Section title="My media folder">
        {local && (
          <div>
            <div className="flex items-center gap-2 text-sm mb-3"><FolderOpen className="w-4 h-4 text-haze-400" /><code className="text-haze-200">{local.dir}</code>{!local.exists && <Pill tone="warn">missing</Pill>}<button className="chip ml-auto" onClick={() => api.rescan().then(reload)}><RefreshCw className="w-3.5 h-3.5" /> Rescan</button></div>
            {local.files.length === 0 ? <p className="text-sm text-haze-400">No video files found. Name movies like <code>Night of the Living Dead (1968).mp4</code> and episodes like <code>Show Name - S01E02.mp4</code>; put matching <code>.srt</code> files next to them.</p> : (
              <div className="glass rounded-2xl divide-y divide-white/5 max-h-80 overflow-y-auto thin-scroll">
                {local.files.map((f) => (
                  <div key={f.id} className="px-4 py-2.5 text-sm flex gap-3">
                    <span className="truncate flex-1 text-haze-200">{f.rel}</span>
                    <span className="text-haze-400 shrink-0">{f.parsed.title}{f.parsed.year ? ` (${f.parsed.year})` : ''}{f.parsed.kind === 'episode' ? ` S${f.parsed.season}E${f.parsed.episode}` : ''}{f.subtitles.length ? ` · subs: ${f.subtitles.join(', ')}` : ''}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Section>

      <Section title="Keyboard shortcuts">
        <div className="grid sm:grid-cols-2 gap-x-10 gap-y-2 text-sm">
          {[['Space / K', 'Play / pause'], ['← / →', 'Back / forward 5 s'], ['J / L', 'Back / forward 10 s'], ['↑ / ↓', 'Volume'], ['M', 'Mute'], ['F', 'Fullscreen'], ['P', 'Picture-in-picture'], ['C', 'Subtitles on/off'], ['G / H', 'Subtitle timing −/+ 0.1 s'], ['< / >', 'Slower / faster'], ['N', 'Next episode'], ['0–9', 'Jump to 0–90%']].map(([k, v]) => (
            <div key={k} className="flex justify-between border-b border-white/5 py-1.5"><span className="text-haze-300">{v}</span><kbd className="font-mono text-xs text-haze-100 bg-white/10 rounded px-2 py-0.5 inline-flex items-center gap-1"><Keyboard className="w-3 h-3" />{k}</kbd></div>
          ))}
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="mb-12">
      <div className="flex items-center mb-4"><h2 className="font-display text-2xl font-semibold">{title}</h2><div className="ml-auto">{action}</div></div>
      {children}
    </section>
  );
}

function ProviderCard({ p, onSaved }: { p: P; onSaved: () => void }) {
  const [vals, setVals] = useState<Record<string, unknown>>(p.config);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(p.requiresConfig && !p.configured);
  const status = !p.enabled ? { icon: <CircleDashed className="w-4 h-4" />, text: 'Disabled', tone: 'neutral' as const }
    : !p.configured ? { icon: <CircleDashed className="w-4 h-4" />, text: 'Needs configuration', tone: 'warn' as const }
    : p.health.ok === false ? { icon: <XCircle className="w-4 h-4" />, text: 'Unreachable', tone: 'bad' as const }
    : { icon: <CheckCircle2 className="w-4 h-4" />, text: p.health.ok ? 'Working' : 'Ready', tone: 'ok' as const };
  const save = async (extra: Record<string, unknown> = {}) => { setBusy(true); try { await api.saveProvider(p.id, { ...vals, ...extra }); onSaved(); } finally { setBusy(false); } };
  return (
    <div className="glass rounded-2xl p-5" data-testid={`provider-${p.id}`}>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap"><span className="font-semibold">{p.name}</span><Pill tone={status.tone}>{status.icon}{status.text}</Pill>{p.kinds.map((k) => <Pill key={k}>{k.toUpperCase()}</Pill>)}</div>
          <p className="text-sm text-haze-400 mt-1">{p.description}</p>
          <div className="text-xs text-haze-500 mt-1">{p.health.lastCheck ? `Checked ${relTime(p.health.lastCheck)}` : 'Not checked yet'}{p.health.latencyMs != null ? ` · ${p.health.latencyMs} ms` : ''}{p.health.lastError ? ` · last error: ${p.health.lastError}` : ''}</div>
        </div>
        <label className="flex items-center gap-2 text-xs text-haze-300 shrink-0"><input type="checkbox" className="accent-[#f5b971]" checked={vals.enabled !== false} onChange={(e) => { setVals({ ...vals, enabled: e.target.checked }); save({ enabled: e.target.checked }); }} />Enabled</label>
      </div>
      {p.configFields.length > 0 && (
        <>
          <button className="text-xs text-ember-300 mt-3" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Configure'}</button>
          {open && (
            <form className="grid sm:grid-cols-2 gap-3 mt-3" onSubmit={(e) => { e.preventDefault(); save(); }}>
              {p.configFields.map((f) => (
                <label key={f.key} className="block">
                  <span className="label">{f.label}</span>
                  <input className="input mt-1" type={f.secret ? 'password' : 'text'} placeholder={f.placeholder} value={String(vals[f.key] ?? '')} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
                  {f.help && <span className="text-[11px] text-haze-500 mt-1 block">{f.help}</span>}
                </label>
              ))}
              <div className={cx('sm:col-span-2')}><button className="btn-accent h-10" disabled={busy}>{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save & test'}</button></div>
            </form>
          )}
        </>
      )}
    </div>
  );
}
