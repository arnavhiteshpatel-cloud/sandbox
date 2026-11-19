import type { ClientMessage, ControlCommand, Participant, RoomState, ServerMessage } from '@shared/types';
import { displayName, store, userId } from '../lib/identity';
import { ServerClock } from './clock';

export type ConnStatus = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'unauthorized' | 'not_found';

type Listener = () => void;

/** WebSocket client for a room: auth, clock sync, automatic reconnection with state restore. */
export class RoomClient {
  ws?: WebSocket;
  state: RoomState | null = null;
  participants: Participant[] = [];
  status: ConnStatus = 'connecting';
  error: string | null = null;
  me = userId();
  clock = new ServerClock();
  chat: { from: string; name: string; text: string; at: number }[] = [];
  private listeners = new Set<Listener>();
  private rtcHandlers = new Set<(from: string, data: any) => void>();
  private stateHandlers = new Set<(s: RoomState, prev: RoomState | null) => void>();
  private retry = 0;
  private pingTimer?: number;
  private closedByUser = false;
  private key: string | null;
  /** Test/diagnostic only: simulated one-way network latency (ms) and jitter, from localStorage 'syncroom.debugLag' = "150,60". */
  private lag = (() => { const [l, j] = (store.get('syncroom.debugLag') ?? '').split(',').map(Number); return { l: l || 0, j: j || 0 }; })();
  private delay(fn: () => void) {
    if (!this.lag.l) return fn();
    setTimeout(fn, Math.max(0, this.lag.l + (Math.random() * 2 - 1) * this.lag.j));
  }

  constructor(public roomId: string, key?: string | null) {
    this.key = key ?? null;
    if (key) store.set(`syncroom.room.${roomId}.key`, key);
    else this.key = store.get(`syncroom.room.${roomId}.key`);
    this.connect();
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.send({ t: 'hello', roomId: this.roomId, userId: this.me, name: displayName() ?? 'Guest', token: store.get(`syncroom.room.${this.roomId}.token`) ?? undefined, key: this.key ?? undefined });
      // burst of pings for a fast initial clock estimate, then steady state
      for (let i = 0; i < 8; i++) setTimeout(() => this.ping(), i * 120);
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.ping(), 4000);
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data) as ServerMessage;
      // pong carries its own timing; apply simulated lag before the receive timestamp is taken
      this.delay(() => this.onMessage(m));
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      if (this.closedByUser || this.status === 'unauthorized' || this.status === 'not_found') return;
      this.setStatus('reconnecting');
      const delay = Math.min(5000, 400 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  private ping() { this.send({ t: 'ping', c: Date.now() }); }

  private onMessage(m: ServerMessage) {
    switch (m.t) {
      case 'pong': this.clock.sample(m.c, m.s, Date.now()); return;
      case 'welcome':
        store.set(`syncroom.room.${this.roomId}.token`, m.token);
        this.retry = 0;
        this.participants = m.participants;
        this.applyState(m.state);
        this.setStatus('open');
        return;
      case 'state': this.applyState(m.state); return;
      case 'participants': this.participants = m.participants; this.emit(); return;
      case 'rtc': this.rtcHandlers.forEach((h) => h(m.from, m.data)); return;
      case 'chat': this.chat = [...this.chat.slice(-99), m]; this.emit(); return;
      case 'error':
        this.error = m.message;
        if (m.code === 'unauthorized' || m.code === 'not_found') { this.setStatus(m.code); this.ws?.close(); }
        else if (m.code === 'replaced') { this.closedByUser = true; this.setStatus('closed'); }
        this.emit();
        if (m.code === 'rejected') setTimeout(() => { if (this.error === m.message) { this.error = null; this.emit(); } }, 3500);
    }
  }

  private applyState(s: RoomState) {
    const prev = this.state;
    if (prev && s.seq < prev.seq && s.roomId === prev.roomId) return; // stale
    this.state = s;
    this.stateHandlers.forEach((h) => h(s, prev));
    this.emit();
  }

  private setStatus(s: ConnStatus) { this.status = s; this.emit(); }
  private emit() { this.listeners.forEach((l) => l()); }
  send(m: ClientMessage) {
    const out = () => { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)); };
    this.delay(out);
  }
  command(cmd: ControlCommand) { this.send({ t: 'cmd', cmd, baseSeq: this.state?.seq ?? 0 }); }
  subscribe(l: Listener) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  onState(h: (s: RoomState, prev: RoomState | null) => void) { this.stateHandlers.add(h); return () => { this.stateHandlers.delete(h); }; }
  onRtc(h: (from: string, data: any) => void) { this.rtcHandlers.add(h); return () => { this.rtcHandlers.delete(h); }; }
  close() { this.closedByUser = true; clearInterval(this.pingTimer); this.ws?.close(); }
}
