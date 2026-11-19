import { Mic, MicOff, Phone, PhoneOff, Video, VideoOff, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cx } from '../lib/format';
import type { RoomClient } from '../sync/roomClient';
import { CallManager } from './call';

/** Floating call controls + draggable camera bubbles. Calling is optional and never blocks playback. */
export function CallDock({ room }: { room: RoomClient }) {
  const call = useMemo(() => new CallManager(room), [room]);
  const [, force] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [blur, setBlur] = useState(false);
  useEffect(() => { const off = call.subscribe(() => force((x) => x + 1)); return () => { off(); call.destroy(); }; }, [call]);
  const remote = [...call.peers.entries()].filter(([, p]) => p.stream.getTracks().length > 0);
  const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

  const start = async (video: boolean) => {
    setErr(null);
    try { await call.start({ video, blur }); } catch (e) { setErr((e as Error).name === 'NotAllowedError' ? 'Microphone/camera permission was denied.' : (e as Error).message); }
  };

  return (
    <>
      <div className="absolute left-3 sm:left-6 bottom-24 z-20 flex flex-col gap-3 items-start" onClick={(e) => e.stopPropagation()}>
        {call.local && call.cam && <Bubble stream={call.local} label="You" muted mirrored />}
        {remote.map(([id, p]) => {
          const who = room.participants.find((x) => x.id === id);
          return <Bubble key={id} stream={p.stream} label={who?.name ?? 'Guest'} showVideo={who?.media?.cam ?? true} color={who?.color} />;
        })}
      </div>
      <div className="absolute left-3 sm:left-6 top-20 z-20 flex gap-2" onClick={(e) => e.stopPropagation()} data-testid="call-dock">
        {!call.active ? (
          supported && (
            <>
              <button className="btn-ghost h-9 px-3 text-xs" onClick={() => start(false)} title="Voice call"><Phone className="w-4 h-4" /><span className="hidden sm:inline">Voice</span></button>
              <button className="btn-ghost h-9 px-3 text-xs" onClick={() => start(true)} title="Video call"><Video className="w-4 h-4" /><span className="hidden sm:inline">Video</span></button>
            </>
          )
        ) : (
          <>
            <button className={cx('btn-icon w-9 h-9', !call.mic && 'bg-bad/30')} onClick={() => call.toggleMic()} aria-label="Toggle microphone">{call.mic ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}</button>
            <button className={cx('btn-icon w-9 h-9', !call.cam && 'bg-white/5')} onClick={() => call.toggleCam().catch((e) => setErr(e.message))} aria-label="Toggle camera">{call.cam ? <Video className="w-4 h-4" /> : <VideoOff className="w-4 h-4" />}</button>
            {call.blurSupported() && <button className={cx('btn-icon w-9 h-9', blur && 'bg-ember-400/30')} onClick={() => { setBlur(!blur); call.setBlur(!blur); }} aria-label="Background blur" title="Background blur"><Wand2 className="w-4 h-4" /></button>}
            <button className="btn-icon w-9 h-9 bg-bad/40 hover:bg-bad/60" onClick={() => call.stop()} aria-label="Leave call"><PhoneOff className="w-4 h-4" /></button>
          </>
        )}
        {err && <span className="glass-strong rounded-full px-3 h-9 inline-flex items-center text-xs text-warn">{err}</span>}
      </div>
    </>
  );
}

function Bubble({ stream, label, muted, mirrored, showVideo = true, color }: { stream: MediaStream; label: string; muted?: boolean; mirrored?: boolean; showVideo?: boolean; color?: string }) {
  const v = useRef<HTMLVideoElement>(null);
  const [vol, setVol] = useState(1);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [big, setBig] = useState(false);
  useEffect(() => { if (v.current && v.current.srcObject !== stream) v.current.srcObject = stream; }, [stream, stream.getTracks().length]);
  useEffect(() => { if (v.current) v.current.volume = vol; }, [vol]);
  const hasVideo = showVideo && stream.getVideoTracks().some((t) => t.enabled && t.readyState === 'live');
  const drag = (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const ox = e.clientX - r.left, oy = e.clientY - r.top;
    const move = (ev: PointerEvent) => setPos({ x: ev.clientX - ox, y: ev.clientY - oy });
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className={cx('group relative rounded-full overflow-hidden ring-2 shadow-lift bg-ink-800 touch-none', big ? 'w-44 h-44' : 'w-24 h-24 sm:w-28 sm:h-28', pos && 'fixed z-50')}
      style={{ ...(pos ? { left: pos.x, top: pos.y } : {}), ['--tw-ring-color' as string]: color ?? 'rgba(255,255,255,.25)' }}
      onPointerDown={drag} onDoubleClick={() => setBig(!big)} data-testid="call-bubble">
      <video ref={v} autoPlay playsInline muted={muted} className={cx('w-full h-full object-cover', mirrored && '-scale-x-100', !hasVideo && 'opacity-0')} />
      {!hasVideo && <div className="absolute inset-0 grid place-items-center font-display text-2xl" style={{ background: color ?? '#2a2a38', color: '#07070a' }}>{label.slice(0, 1)}</div>}
      <div className="absolute inset-x-0 bottom-0 text-[10px] text-center bg-black/50 py-0.5 truncate">{label}</div>
      {!muted && <input type="range" min={0} max={1} step={0.05} value={vol} onChange={(e) => setVol(Number(e.target.value))} onPointerDown={(e) => e.stopPropagation()} className="slim absolute left-2 right-2 top-1/2 opacity-0 group-hover:opacity-100 transition" aria-label={`${label} volume`} />}
    </div>
  );
}
