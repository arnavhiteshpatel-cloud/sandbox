import { DoorOpen, Loader2, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Empty, NamePrompt } from '../components/ui';
import { api } from '../lib/api';
import { epCode, relTime } from '../lib/format';
import { displayName, store } from '../lib/identity';

export default function Rooms() {
  const nav = useNavigate();
  const [rooms, setRooms] = useState<Awaited<ReturnType<typeof api.rooms>>['rooms'] | null>(null);
  const [name, setName] = useState('Movie night');
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [join, setJoin] = useState('');
  useEffect(() => { api.rooms().then((r) => setRooms(r.rooms)).catch(() => setRooms([])); }, []);
  const create = async () => {
    if (!displayName()) { setAsk(true); return; }
    setBusy(true);
    const { roomId, key } = await api.createRoom(name);
    store.set(`syncroom.room.${roomId}.key`, key);
    nav(`/room/${roomId}#k=${key}`);
  };
  return (
    <div className="pt-28 sm:pt-24 px-4 sm:px-10 max-w-4xl">
      <h1 className="font-display text-4xl font-semibold mb-2">Rooms</h1>
      <p className="text-haze-400 mb-8">A room keeps two (or more) players in lock-step. Create one, send the private link, pick something to watch.</p>
      <div className="grid sm:grid-cols-2 gap-4 mb-12">
        <form className="glass rounded-3xl p-6" onSubmit={(e) => { e.preventDefault(); create(); }}>
          <div className="font-display text-xl mb-3">New room</div>
          <input className="input mb-3" value={name} onChange={(e) => setName(e.target.value)} placeholder="Room name" data-testid="room-name" />
          <button className="btn-accent w-full" disabled={busy} data-testid="create-room">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create private room</button>
        </form>
        <form className="glass rounded-3xl p-6" onSubmit={(e) => { e.preventDefault(); try { const u = new URL(join); nav(u.pathname + u.hash); } catch { /* not a url */ } }}>
          <div className="font-display text-xl mb-3">Join with a link</div>
          <input className="input mb-3" value={join} onChange={(e) => setJoin(e.target.value)} placeholder="Paste invitation link" />
          <button className="btn-ghost w-full" disabled={!join}><DoorOpen className="w-4 h-4" /> Join</button>
        </form>
      </div>
      <h2 className="font-display text-2xl font-semibold mb-4">Your rooms</h2>
      {rooms && !rooms.length && <Empty>No rooms yet.</Empty>}
      <div className="grid gap-3">
        {rooms?.map((r) => (
          <Link key={r.id} to={`/room/${r.id}`} className="glass rounded-2xl p-4 flex gap-4 items-center hover:bg-white/[.06] transition">
            <div className="w-24 aspect-video rounded-lg bg-ink-800 overflow-hidden shrink-0">{r.media?.title.background && <img src={r.media.title.background} alt="" className="w-full h-full object-cover" />}</div>
            <div className="min-w-0 flex-1">
              <div className="font-semibold truncate">{r.name}</div>
              <div className="text-sm text-haze-400 truncate">{r.media ? `${r.media.title.name}${r.media.ref.type === 'series' ? ` · ${epCode(r.media.ref.season, r.media.ref.episode)}` : ''}` : 'Nothing playing'} · {relTime(r.updatedAt)}</div>
            </div>
            {r.online > 0 && <span className="text-xs text-ok">{r.online} online</span>}
          </Link>
        ))}
      </div>
      <NamePrompt open={ask} onCancel={() => setAsk(false)} onDone={() => { setAsk(false); create(); }} />
    </div>
  );
}
