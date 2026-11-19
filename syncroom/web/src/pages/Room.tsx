import { ArrowLeft, Check, Copy, Crown, Link2, Loader2, MessageSquare, Search, Send, Share2, Users, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { MediaRef, PlaybackSource, ProgressEntry, RoomMedia, TitleDetail } from '@shared/types';
import { mediaKey } from '@shared/types';
import { NamePrompt, Spinner } from '../components/ui';
import { api, type Title } from '../lib/api';
import { cx, epCode } from '../lib/format';
import { displayName, store } from '../lib/identity';
import { Player } from '../player/Player';
import { CallDock } from '../rtc/CallDock';
import { RoomClient } from '../sync/roomClient';
import { summaryOf } from './Title';

const detailCache = new Map<string, Promise<TitleDetail>>();
function getDetail(ref: MediaRef) {
  const k = `${ref.type}:${ref.titleId}`;
  if (!detailCache.has(k)) detailCache.set(k, api.title(ref.type, ref.titleId).catch((e) => { detailCache.delete(k); throw e; }));
  return detailCache.get(k)!;
}

/** Resolve a playable source for a ref and build the room media descriptor. */
async function resolveMedia(ref: MediaRef, preferProvider?: string): Promise<RoomMedia> {
  const [detail, srcs] = await Promise.all([getDetail(ref), api.sources(ref)]);
  const verified = srcs.sources.filter((s) => s.verify.status === 'verified' && s.capabilities.syncGrade !== 'none');
  const source = verified.find((s) => s.providerId === preferProvider) ?? verified[0];
  if (!source) throw new Error(`No verified playable source for ${detail.name}${ref.type === 'series' ? ` ${epCode(ref.season, ref.episode)}` : ''}`);
  const ep = detail.episodes?.find((e) => e.season === ref.season && e.episode === ref.episode);
  return { ref, sourceId: source.id, source, title: summaryOf(detail), episodeName: ep?.name };
}

function useRoom(client: RoomClient | null) {
  const sub = useCallback((cb: () => void) => (client ? client.subscribe(cb) : () => {}), [client]);
  const [, force] = useState(0);
  const snap = useSyncExternalStore(sub, () => (client ? `${client.status}|${client.state?.seq}|${client.participants.map((p) => `${p.id}${p.connected}${p.buffering}${p.ready}${p.driftMs}${p.media?.cam}${p.media?.mic}`).join()}|${client.chat.length}|${client.error}` : ''));
  useEffect(() => force((x) => x + 1), [snap]);
  return client;
}

export default function Room() {
  const { roomId } = useParams() as { roomId: string };
  const nav = useNavigate();
  const [named, setNamed] = useState(!!displayName());
  const key = useMemo(() => new URLSearchParams(location.hash.slice(1)).get('k'), []);
  const [client, setClient] = useState<RoomClient | null>(null);
  useEffect(() => {
    if (!named) return;
    const c = new RoomClient(roomId, key);
    (window as any).__syncroom = { room: c }; // diagnostics / automated tests
    setClient(c);
    if (key) history.replaceState(null, '', location.pathname); // keep the secret out of the address bar after joining
    return () => c.close();
  }, [roomId, named, key]);
  const room = useRoom(client);
  const st = room?.state ?? null;

  const [detail, setDetail] = useState<TitleDetail | null>(null);
  const [sources, setSources] = useState<PlaybackSource[]>([]);
  const [panel, setPanel] = useState<null | 'people' | 'chat' | 'settings'>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadingMedia, setLoadingMedia] = useState<string | null>(null);

  const media = st?.media ?? null;
  const mk = media ? mediaKey(media.ref) : '';

  useEffect(() => {
    if (!media) { setDetail(null); return; }
    getDetail(media.ref).then(setDetail).catch(() => {});
    api.sources(media.ref).then((r) => setSources(r.sources)).catch(() => setSources([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mk]);

  const load = useCallback(async (ref: MediaRef, opts: { position?: number; autoplay?: boolean; preferProvider?: string } = {}) => {
    if (!room) return;
    setLoadingMedia('Finding a verified source…');
    try {
      const m = await resolveMedia(ref, opts.preferProvider);
      room.command({ type: 'load', media: m, position: opts.position ?? 0, autoplay: opts.autoplay ?? false });
      setNotice(null);
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setLoadingMedia(null);
    }
  }, [room]);

  // Media handed over from the title page when the room was created
  useEffect(() => {
    if (!room || room.status !== 'open') return;
    const k = `syncroom.pendingLoad.${roomId}`;
    const pending = sessionStorage.getItem(k);
    if (!pending) return;
    sessionStorage.removeItem(k);
    const { ref, position } = JSON.parse(pending) as { ref: MediaRef; position: number };
    load(ref, { position, autoplay: false });
  }, [room, room?.status, roomId, load]);

  // Room-level error notices from the server (e.g. host-only)
  useEffect(() => { if (room?.error) setNotice(room.error); }, [room?.error]);

  const onEnded = useCallback(async () => {
    if (!room?.state?.media || !detail) return;
    const cur = room.state.media;
    const eps = detail.episodes ?? [];
    let next: RoomMedia | null = null;
    if (cur.ref.type === 'series' && room.state.settings.autoplayNext) {
      const i = eps.findIndex((e) => e.season === cur.ref.season && e.episode === cur.ref.episode);
      const ne = eps.slice(i + 1).find((e) => e.season > 0 && !e.upcoming);
      if (ne) {
        try { next = await resolveMedia({ titleId: cur.ref.titleId, type: 'series', season: ne.season, episode: ne.episode }, cur.source.providerId); }
        catch (e) { setNotice(`Next episode: ${(e as Error).message}`); }
      }
    }
    room.command({ type: 'ended', mediaKey: mediaKey(cur.ref), next });
  }, [room, detail]);

  if (!named) return <div className="fixed inset-0 bg-ink-950"><NamePrompt open title="Join the room" onCancel={() => nav('/')} onDone={() => setNamed(true)} /></div>;
  if (!room || room.status === 'connecting' || (!st && room.status !== 'unauthorized' && room.status !== 'not_found')) {
    return <div className="fixed inset-0 grid place-items-center bg-ink-950"><div className="flex flex-col items-center gap-3 text-haze-300"><Spinner />Connecting to room…</div></div>;
  }
  if (room.status === 'unauthorized' || room.status === 'not_found') {
    return (
      <div className="fixed inset-0 grid place-items-center bg-ink-950 p-6 text-center" data-testid="room-denied">
        <div className="max-w-sm">
          <div className="font-display text-3xl mb-2">{room.status === 'not_found' ? 'Room not found' : 'Private room'}</div>
          <p className="text-haze-400 mb-6">{room.error}</p>
          <button className="btn-primary" onClick={() => nav('/')}>Go home</button>
        </div>
      </div>
    );
  }

  const me = room.participants.find((p) => p.id === room.me);
  const isHost = st!.hostId === room.me;
  const online = room.participants.filter((p) => p.connected);

  const topRight = (
    <div className="flex items-center gap-2 shrink-0">
      <div className="hidden sm:flex -space-x-2 mr-1" data-testid="participants">
        {online.map((p) => <Avatar key={p.id} p={p} />)}
      </div>
      <button className="btn-icon w-10 h-10" onClick={() => setInviteOpen(true)} aria-label="Invite" data-testid="invite-btn"><Share2 className="w-[18px] h-[18px]" /></button>
      <button className={cx('btn-icon w-10 h-10 relative', panel === 'people' && 'bg-white/15')} onClick={() => setPanel(panel === 'people' ? null : 'people')} aria-label="Room"><Users className="w-[18px] h-[18px]" /><span className="absolute -top-0.5 -right-0.5 text-[10px] bg-ember-400 text-ink-950 rounded-full w-4 h-4 grid place-items-center font-bold">{online.length}</span></button>
      <button className={cx('btn-icon w-10 h-10', panel === 'chat' && 'bg-white/15')} onClick={() => setPanel(panel === 'chat' ? null : 'chat')} aria-label="Chat"><MessageSquare className="w-[18px] h-[18px]" /></button>
    </div>
  );

  const sidePanel = panel && (
    <div className="absolute top-20 right-3 sm:right-5 bottom-28 z-30 w-[min(92vw,340px)] glass-strong rounded-2xl flex flex-col animate-fadeUp" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-1 p-2 border-b border-white/10">
        {(['people', 'chat', 'settings'] as const).map((t) => <button key={t} onClick={() => setPanel(t)} className={cx('chip h-8 capitalize', panel === t && 'chip-on')}>{t === 'people' ? 'People' : t === 'chat' ? 'Chat' : 'Room settings'}</button>)}
        <button className="ml-auto w-8 h-8 grid place-items-center rounded-full hover:bg-white/10" onClick={() => setPanel(null)} aria-label="Close"><X className="w-4 h-4" /></button>
      </div>
      {panel === 'people' && <PeopleList room={room} isHost={isHost} />}
      {panel === 'chat' && <Chat room={room} />}
      {panel === 'settings' && <RoomSettingsPanel room={room} isHost={isHost} />}
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black" data-testid="room">
      {media && detail ? (
        <Player
          key={`${mk}|${media.sourceId}`}
          detail={detail}
          mediaRef={media.ref}
          source={media.source}
          sources={sources.length ? sources : [media.source]}
          room={room}
          onRoomEnded={onEnded}
          onBack={() => nav('/')}
          onSourceChange={(s, pos) => room.command({ type: 'load', media: { ...media, sourceId: s.id, source: s }, position: pos, autoplay: st!.playing })}
          onEpisode={(ref) => load(ref, { autoplay: true, preferProvider: media.source.providerId })}
          topRight={topRight}
          overlay={
            <>
              {sidePanel}
              {st!.waitingFor.length > 0 && st!.playing && (
                <div className="absolute left-1/2 -translate-x-1/2 bottom-28 z-20 glass-strong rounded-full px-4 py-2 text-sm flex items-center gap-2" data-testid="waiting-banner">
                  <Loader2 className="w-4 h-4 animate-spin" /> Waiting for {st!.waitingFor.map((id) => room.participants.find((p) => p.id === id)?.name ?? 'someone').join(', ')}…
                </div>
              )}
              {st!.lastAction && Date.now() - st!.lastAction.at < 2500 && st!.lastAction.by !== room.me && st!.lastAction.by !== 'server' && (
                <div key={st!.seq} className="absolute left-1/2 -translate-x-1/2 top-24 z-20 glass-strong rounded-full px-4 py-1.5 text-sm animate-fadeUp">
                  {st!.lastAction.byName} {({ play: 'pressed play', pause: 'paused', seek: 'jumped', load: 'changed what’s playing', rate: 'changed speed', restart: 'restarted', ended: 'moved on' } as Record<string, string>)[st!.lastAction.type] ?? st!.lastAction.type}
                </div>
              )}
              {notice && <Notice text={notice} onClose={() => setNotice(null)} />}
              <CallDock room={room} />
            </>
          }
        />
      ) : (
        <Lobby room={room} onPick={(ref) => load(ref)} loading={loadingMedia} notice={notice} onNotice={setNotice} onInvite={() => setInviteOpen(true)} topRight={topRight} sidePanel={sidePanel} />
      )}
      {me?.sourceError && <Notice text={`Your player couldn't play this source: ${me.sourceError}. Pick another source from the server menu — it switches for everyone.`} onClose={() => {}} />}
      {inviteOpen && <InviteModal roomId={roomId} onClose={() => setInviteOpen(false)} />}
    </div>
  );
}

function Notice({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div className="absolute left-1/2 -translate-x-1/2 top-24 z-40 glass-strong rounded-2xl px-4 py-3 text-sm max-w-md flex gap-3 items-start animate-fadeUp" data-testid="room-notice">
      <span className="flex-1">{text}</span>
      <button onClick={onClose} aria-label="Dismiss"><X className="w-4 h-4" /></button>
    </div>
  );
}

function Avatar({ p, size = 'w-9 h-9' }: { p: { name: string; color: string; connected: boolean }; size?: string }) {
  return (
    <span className={cx(size, 'rounded-full grid place-items-center text-xs font-bold ring-2 ring-black text-ink-950', !p.connected && 'opacity-40')} style={{ background: p.color }} title={p.name}>
      {p.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function PeopleList({ room, isHost }: { room: RoomClient; isHost: boolean }) {
  const st = room.state!;
  return (
    <div className="p-3 space-y-1 overflow-y-auto thin-scroll" data-testid="people-list">
      {room.participants.map((p) => (
        <div key={p.id} className="flex items-center gap-3 rounded-xl p-2 hover:bg-white/[.04]">
          <Avatar p={p} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium flex items-center gap-1.5 truncate">{p.name}{p.id === room.me && <span className="text-haze-500 font-normal">(you)</span>}{st.hostId === p.id && <Crown className="w-3.5 h-3.5 text-ember-400" />}</div>
            <div className="text-xs text-haze-400">
              {!p.connected ? 'Offline — will rejoin where you left off' : p.sourceError ? <span className="text-bad">Can't play source</span> : p.buffering ? <span className="text-warn">Buffering…</span> : !p.ready ? 'Loading…' : <span className="text-ok">Ready</span>}
              {p.connected && p.driftMs != null && st.playing && <span className="ml-2 tabular-nums">drift {Math.abs(p.driftMs)} ms</span>}
              {p.connected && p.rttMs ? <span className="ml-2 tabular-nums">ping {p.rttMs} ms</span> : null}
            </div>
          </div>
          {isHost && p.id !== room.me && p.connected && <button className="chip h-7 text-xs" onClick={() => room.command({ type: 'transferHost', to: p.id })}>Make host</button>}
        </div>
      ))}
    </div>
  );
}

function Chat({ room }: { room: RoomClient }) {
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ behavior: 'smooth' }), [room.chat.length]);
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-1 overflow-y-auto thin-scroll p-3 space-y-2">
        {!room.chat.length && <div className="text-sm text-haze-500 text-center mt-8">Say hi 👋</div>}
        {room.chat.map((m, i) => (
          <div key={i} className={cx('text-sm', m.from === room.me && 'text-right')}>
            <div className="text-[11px] text-haze-500 mb-0.5">{m.name}</div>
            <span className={cx('inline-block rounded-2xl px-3 py-1.5 max-w-[85%] text-left', m.from === room.me ? 'bg-ember-400 text-ink-950' : 'bg-white/10')}>{m.text}</span>
          </div>
        ))}
        <div ref={end} />
      </div>
      <form className="p-2 flex gap-2 border-t border-white/10" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { room.send({ t: 'chat', text }); setText(''); } }}>
        <input className="input h-10" value={text} onChange={(e) => setText(e.target.value)} placeholder="Message" />
        <button className="btn-icon w-10 h-10 shrink-0" aria-label="Send"><Send className="w-4 h-4" /></button>
      </form>
    </div>
  );
}

function RoomSettingsPanel({ room, isHost }: { room: RoomClient; isHost: boolean }) {
  const s = room.state!.settings;
  const Toggle = ({ k, label, hint, hostOnly }: { k: keyof typeof s; label: string; hint: string; hostOnly?: boolean }) => (
    <label className={cx('flex gap-3 items-start rounded-xl p-3 hover:bg-white/[.04] cursor-pointer', hostOnly && !isHost && 'opacity-50 pointer-events-none')}>
      <input type="checkbox" className="mt-1 accent-[#f5b971]" checked={s[k]} onChange={(e) => room.command({ type: 'settings', settings: { [k]: e.target.checked } })} />
      <span><span className="block text-sm font-medium">{label}</span><span className="block text-xs text-haze-400">{hint}</span></span>
    </label>
  );
  return (
    <div className="p-2 overflow-y-auto thin-scroll">
      <Toggle k="pauseOnBuffer" label="Wait for each other" hint="If anyone buffers or is loading, everyone pauses until they're ready." />
      <Toggle k="autoplayNext" label="Autoplay next episode" hint="Both players move to the next episode together." />
      <Toggle k="hostOnly" label="Only the host controls playback" hint="Otherwise anyone can play, pause, seek and change what's on." hostOnly />
      <div className="px-3 pt-2 text-xs text-haze-500 leading-relaxed">Conflicting controls are resolved by the server in arrival order; the last command wins and every player converges to it.</div>
    </div>
  );
}

function InviteModal({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const key = store.get(`syncroom.room.${roomId}.key`);
  const [net, setNet] = useState<{ publicUrl: string | null; lan: string[] } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => { api.network().then(setNet).catch(() => setNet({ publicUrl: null, lan: [] })); }, []);
  const isLocal = /^(localhost|127\.)/.test(location.hostname);
  const bases = [net?.publicUrl, location.origin, ...(isLocal ? net?.lan ?? [] : [])].filter((x, i, a): x is string => !!x && a.indexOf(x) === i);
  const link = (b: string) => `${b}/room/${roomId}#k=${key}`;
  const copy = async (u: string) => { try { await navigator.clipboard.writeText(u); } catch { /* */ } setCopied(u); setTimeout(() => setCopied(null), 1600); };
  return (
    <div className="fixed inset-0 z-[100] grid place-items-center p-4 bg-black/70 backdrop-blur-sm animate-fadeIn" onClick={onClose}>
      <div className="glass-strong rounded-3xl w-full max-w-lg p-7 animate-fadeUp" onClick={(e) => e.stopPropagation()} data-testid="invite-modal">
        <div className="font-display text-2xl mb-1">Invite to this room</div>
        <p className="text-sm text-haze-400 mb-5">Anyone with this private link can join. The secret after <code>#k=</code> never reaches server logs.</p>
        {!key && <p className="text-sm text-warn mb-4">This browser doesn't have the room's invitation key. Ask the person who invited you to share the link.</p>}
        {key && bases.map((b) => (
          <div key={b} className="flex gap-2 mb-2">
            <input readOnly value={link(b)} className="input h-10 text-xs font-mono" data-testid="invite-link" onFocus={(e) => e.target.select()} />
            <button className="btn-ghost h-10 px-3 shrink-0" onClick={() => copy(link(b))}>{copied === link(b) ? <Check className="w-4 h-4 text-ok" /> : <Copy className="w-4 h-4" />}</button>
          </div>
        ))}
        {isLocal && key && <p className="text-xs text-haze-500 mt-2">“localhost” links only work on this computer. For a partner on the same Wi‑Fi use the LAN address; for someone elsewhere, run SyncRoom behind a tunnel and set SYNCROOM_PUBLIC_URL.</p>}
        <div className="flex gap-2 mt-5">
          {key && 'share' in navigator && <button className="btn-accent flex-1" onClick={() => navigator.share({ title: 'Watch with me on SyncRoom', url: link(bases[0]) }).catch(() => {})}><Share2 className="w-4 h-4" /> Share</button>}
          <button className="btn-ghost flex-1" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

function Lobby({ room, onPick, loading, notice, onNotice, onInvite, topRight, sidePanel }: {
  room: RoomClient; onPick: (ref: MediaRef) => void; loading: string | null; notice: string | null; onNotice: (s: string | null) => void; onInvite: () => void; topRight: React.ReactNode; sidePanel: React.ReactNode;
}) {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Title[]>([]);
  const [free, setFree] = useState<Title[]>([]);
  const [cont, setCont] = useState<ProgressEntry[]>([]);
  const [series, setSeries] = useState<TitleDetail | null>(null);
  const [season, setSeason] = useState(1);
  useEffect(() => { api.free(0, 18).then((r) => setFree(r.items)).catch(() => {}); api.progress().then((r) => setCont(r.continueWatching)).catch(() => {}); }, []);
  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return; }
    const t = setTimeout(() => api.search({ q }).then((r) => setResults(r.items.slice(0, 18))).catch(() => {}), 220);
    return () => clearTimeout(t);
  }, [q]);
  const pick = (t: Title) => {
    if (t.type === 'movie') onPick({ titleId: t.id, type: 'movie' });
    else getDetail({ titleId: t.id, type: 'series' }).then((d) => { setSeries(d); setSeason(d.seasons?.find((s) => s > 0) ?? 1); }).catch((e) => onNotice(e.message));
  };
  const online = room.participants.filter((p) => p.connected);
  return (
    <div className="absolute inset-0 overflow-y-auto bg-ink-950" data-testid="lobby">
      <div className="sticky top-0 z-20 glass-strong border-x-0 border-t-0 px-4 sm:px-8 h-16 flex items-center gap-3">
        <button className="btn-icon w-10 h-10" onClick={() => nav('/')} aria-label="Home"><ArrowLeft className="w-5 h-5" /></button>
        <div className="min-w-0 flex-1">
          <div className="font-display text-lg truncate">{room.state!.name}</div>
          <div className="text-xs text-haze-400">{online.length} here · pick something to watch together</div>
        </div>
        {topRight}
      </div>
      <div className="relative">{sidePanel}</div>
      <div className="max-w-6xl mx-auto px-4 sm:px-8 py-8">
        {online.length < 2 && (
          <div className="glass rounded-3xl p-6 sm:p-8 mb-8 flex flex-col sm:flex-row gap-5 items-start sm:items-center">
            <div className="w-12 h-12 rounded-2xl bg-ember-400/15 grid place-items-center"><Link2 className="w-6 h-6 text-ember-300" /></div>
            <div className="flex-1"><div className="font-display text-xl">Waiting for your partner</div><div className="text-sm text-haze-400">Send them the private invitation link. Playback starts in sync for both of you.</div></div>
            <button className="btn-accent" onClick={onInvite}><Share2 className="w-4 h-4" /> Invite</button>
          </div>
        )}
        {notice && <div className="mb-6 rounded-2xl border border-warn/30 bg-warn/10 text-warn px-4 py-3 text-sm flex gap-3"><span className="flex-1">{notice}</span><button onClick={() => onNotice(null)}><X className="w-4 h-4" /></button></div>}
        {loading && <div className="mb-6 flex items-center gap-2 text-haze-300"><Loader2 className="w-4 h-4 animate-spin" />{loading}</div>}
        <div className="relative mb-8">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-haze-400" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search for a movie or show to watch together" className="input h-14 pl-12 text-base rounded-2xl" data-testid="lobby-search" />
        </div>
        {series && (
          <div className="glass rounded-3xl p-5 mb-8 animate-fadeUp">
            <div className="flex items-center gap-3 mb-4">
              <div className="font-display text-xl flex-1">{series.name}</div>
              <select className="input h-9 w-auto" value={season} onChange={(e) => setSeason(Number(e.target.value))}>{series.seasons?.map((s) => <option key={s} value={s}>{s === 0 ? 'Specials' : `Season ${s}`}</option>)}</select>
              <button className="btn-icon w-9 h-9" onClick={() => setSeries(null)}><X className="w-4 h-4" /></button>
            </div>
            <div className="grid sm:grid-cols-2 gap-2 max-h-[50vh] overflow-y-auto thin-scroll">
              {series.episodes?.filter((e) => e.season === season).map((e) => (
                <button key={e.id} disabled={e.upcoming} onClick={() => { setSeries(null); onPick({ titleId: series.id, type: 'series', season: e.season, episode: e.episode }); }} className="flex gap-3 text-left rounded-xl p-2 hover:bg-white/10 disabled:opacity-40">
                  <div className="w-28 aspect-video rounded-lg bg-ink-700 overflow-hidden shrink-0">{e.thumbnail && <img src={e.thumbnail} alt="" className="w-full h-full object-cover" loading="lazy" />}</div>
                  <div className="min-w-0"><div className="text-xs text-haze-400">E{e.episode}</div><div className="text-sm font-medium line-clamp-2">{e.name}</div></div>
                </button>
              ))}
            </div>
          </div>
        )}
        {results.length > 0 && <Grid title="Results" items={results} onPick={pick} />}
        {!q && cont.length > 0 && (
          <div className="mb-8">
            <div className="label mb-3">Continue watching</div>
            <div className="flex gap-3 overflow-x-auto scroll-row pb-2">
              {cont.map((c) => (
                <button key={c.mediaKey} onClick={() => onPick(c.ref)} className="shrink-0 w-56 text-left group">
                  <div className="aspect-video rounded-xl overflow-hidden bg-ink-800">{(c.title.background ?? c.title.poster) && <img src={c.title.background ?? c.title.poster} alt="" className="w-full h-full object-cover group-hover:scale-105 transition" />}</div>
                  <div className="text-sm mt-1.5 truncate">{c.title.name}</div>
                  <div className="text-xs text-haze-400">{c.ref.type === 'series' ? epCode(c.ref.season, c.ref.episode) : 'Movie'}</div>
                </button>
              ))}
            </div>
          </div>
        )}
        {!q && free.length > 0 && <Grid title="Verified playable — ad-free" items={free} onPick={pick} />}
      </div>
    </div>
  );
}

function Grid({ title, items, onPick }: { title: string; items: Title[]; onPick: (t: Title) => void }) {
  return (
    <div className="mb-8">
      <div className="label mb-3">{title}</div>
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
        {items.map((t) => (
          <button key={t.type + t.id} onClick={() => onPick(t)} className="text-left group" data-testid="lobby-item">
            <div className="relative aspect-[2/3] rounded-xl overflow-hidden bg-ink-800 ring-1 ring-white/5 group-hover:ring-white/30 transition">
              <div className="absolute inset-0 grid place-items-center p-2 text-center font-display text-sm text-haze-300">{t.name}</div>
              {t.poster && <img src={t.poster} alt="" className="relative w-full h-full object-cover" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />}
              {t.playable && <span className="absolute top-1.5 left-1.5 rounded-full bg-ok/90 text-ink-950 text-[9px] font-bold px-1.5 h-4 inline-flex items-center">WATCH</span>}
            </div>
            <div className="text-xs mt-1.5 line-clamp-1">{t.name}</div>
            <div className="text-[11px] text-haze-500">{t.type === 'series' ? 'Series' : t.releaseInfo}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

