import type { WebSocket } from 'ws';
import type { ClientMessage, ControlCommand, Participant, RoomMedia, RoomState, ServerMessage } from '../../shared/types.ts';
import { expectedPosition, mediaKey } from '../../shared/types.ts';
import { db } from '../db.ts';
import { hash, randomId } from '../lib/sign.ts';

/** Start/resume is scheduled this far in the future so every client begins on the same server-clock instant. */
export const START_LEAD_MS = 350;
const LOAD_WAIT_MS = 15000;
const BUFFER_WAIT_MS = 10000;
const COLORS = ['#f5b971', '#8ec5ff', '#c4a7ff', '#7ee0b8', '#ff9fb2', '#ffd36e'];

interface Conn { ws: WebSocket; participant: Participant; ackSeq: number }

interface Room {
  state: RoomState;
  conns: Map<string, Conn>;
  /** participants who have been in the room (kept for display after disconnect) */
  known: Map<string, Participant>;
  waitTimer?: NodeJS.Timeout;
  saveTimer?: NodeJS.Timeout;
}

const rooms = new Map<string, Room>();

function defaultState(roomId: string, name: string, hostId: string): RoomState {
  return {
    roomId, name, hostId, media: null, playing: false, position: 0, rate: 1, updatedAt: Date.now(), seq: 0, waitingFor: [],
    settings: { pauseOnBuffer: true, autoplayNext: true, hostOnly: false },
  };
}

export function createRoom(userId: string, name: string) {
  const id = randomId(6).replace(/[-_]/g, 'x');
  const key = randomId(16);
  const state = defaultState(id, name.trim().slice(0, 60) || 'Movie night', userId);
  db.prepare('INSERT INTO rooms (id, name, key_hash, created_by, state_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run(id, state.name, hash(key), userId, JSON.stringify(state), Date.now(), Date.now());
  return { roomId: id, key };
}

export function listUserRooms(userId: string) {
  return (db.prepare('SELECT r.id, r.name, r.state_json, r.updated_at FROM rooms r JOIN room_members m ON m.room_id = r.id WHERE m.user_id = ? ORDER BY r.updated_at DESC LIMIT 20').all(userId) as { id: string; name: string; state_json: string; updated_at: number }[]).map((r) => {
    const s = JSON.parse(r.state_json) as RoomState;
    return { id: r.id, name: r.name, updatedAt: r.updated_at, media: s.media ? { title: s.media.title, episodeName: s.media.episodeName, ref: s.media.ref } : null, online: rooms.get(r.id)?.conns.size ?? 0 };
  });
}

function loadRoom(roomId: string): Room | null {
  const live = rooms.get(roomId);
  if (live) return live;
  const row = db.prepare('SELECT state_json FROM rooms WHERE id = ?').get(roomId) as { state_json: string } | undefined;
  if (!row) return null;
  const state = JSON.parse(row.state_json) as RoomState;
  // A room restored from disk: nobody is connected, so hold playback where it was.
  if (state.playing) {
    state.position = expectedPosition({ ...state, waitingFor: [] }, Date.now());
    state.playing = false;
  }
  state.waitingFor = [];
  state.updatedAt = Date.now();
  const room: Room = { state, conns: new Map(), known: new Map() };
  rooms.set(roomId, room);
  return room;
}

function persist(room: Room, immediate = false) {
  const write = () => {
    room.saveTimer = undefined;
    db.prepare('UPDATE rooms SET state_json = ?, name = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(room.state), room.state.name, Date.now(), room.state.roomId);
  };
  if (immediate) { clearTimeout(room.saveTimer); write(); return; }
  if (!room.saveTimer) room.saveTimer = setTimeout(write, 1000);
}

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function participants(room: Room): Participant[] {
  return [...room.known.values()].sort((a, b) => Number(b.connected) - Number(a.connected));
}

function broadcast(room: Room, msg: ServerMessage) {
  for (const c of room.conns.values()) send(c.ws, msg);
}
function broadcastState(room: Room) {
  broadcast(room, { t: 'state', state: room.state, serverTime: Date.now() });
  persist(room);
}
function broadcastParticipants(room: Room) {
  broadcast(room, { t: 'participants', participants: participants(room) });
}

/** Freeze the clock: position becomes the current expected position at `now`. */
function freeze(s: RoomState, now: number) {
  s.position = Math.max(0, expectedPosition(s, now));
  s.updatedAt = now;
}

function startWaiting(room: Room, ids: string[], ms: number) {
  const s = room.state;
  s.waitingFor = [...new Set(ids)];
  clearTimeout(room.waitTimer);
  if (s.waitingFor.length) {
    room.waitTimer = setTimeout(() => {
      // Don't hold the room hostage: stragglers will catch up via drift correction.
      if (room.state.waitingFor.length) {
        room.state.lastAction = { by: 'server', byName: 'SyncRoom', type: 'wait-timeout', at: Date.now() };
        releaseWait(room);
      }
    }, ms);
  }
}

function releaseWait(room: Room) {
  const s = room.state;
  clearTimeout(room.waitTimer);
  s.waitingFor = [];
  s.updatedAt = Date.now() + (s.playing ? START_LEAD_MS : 0);
  s.seq++;
  broadcastState(room);
}

function connectedIds(room: Room) {
  return [...room.conns.keys()];
}

export function applyCommand(room: Room, by: Participant, cmd: ControlCommand): string | null {
  const s = room.state;
  const now = Date.now();
  const transport = cmd.type !== 'ended' && cmd.type !== 'settings';
  if (s.settings.hostOnly && transport && by.id !== s.hostId && cmd.type !== 'transferHost') return 'Only the host can control playback in this room';
  if (cmd.type === 'transferHost' && by.id !== s.hostId) return 'Only the host can transfer host';

  const waitAll = () => (s.settings.pauseOnBuffer ? startWaiting(room, connectedIds(room), LOAD_WAIT_MS) : (s.waitingFor = []));

  switch (cmd.type) {
    case 'play':
      if (!s.media) return 'Nothing loaded';
      if (s.playing && !s.waitingFor.length) return null;
      freeze(s, now);
      s.playing = true;
      if (s.waitingFor.length) {
        // explicit play overrides a buffering hold
        clearTimeout(room.waitTimer);
        s.waitingFor = [];
      }
      s.updatedAt = now + START_LEAD_MS;
      break;
    case 'pause':
      freeze(s, now);
      s.playing = false;
      break;
    case 'seek':
      if (!s.media) return 'Nothing loaded';
      s.position = Math.max(0, cmd.position);
      s.updatedAt = now + (s.playing ? START_LEAD_MS : 0);
      if (s.playing) waitAll();
      break;
    case 'restart':
      if (!s.media) return 'Nothing loaded';
      s.position = 0;
      s.playing = true;
      s.updatedAt = now + START_LEAD_MS;
      waitAll();
      break;
    case 'rate':
      freeze(s, now);
      s.rate = Math.min(2, Math.max(0.25, cmd.rate));
      break;
    case 'load':
      loadMedia(room, cmd.media, cmd.position ?? 0, cmd.autoplay ?? true);
      break;
    case 'ended': {
      // Idempotent: only the first "ended" for the current media advances the room.
      if (!s.media || mediaKey(s.media.ref) !== cmd.mediaKey) return null;
      if (cmd.next && s.settings.autoplayNext) loadMedia(room, cmd.next, 0, true);
      else { freeze(s, now); s.playing = false; }
      break;
    }
    case 'settings':
      s.settings = { ...s.settings, ...cmd.settings };
      if (!s.settings.pauseOnBuffer && s.waitingFor.length) { releaseWait(room); return null; }
      break;
    case 'transferHost':
      if (!room.known.has(cmd.to)) return 'Unknown participant';
      s.hostId = cmd.to;
      break;
  }
  s.seq++;
  s.lastAction = { by: by.id, byName: by.name, type: cmd.type, at: now };
  broadcastState(room);
  return null;
}

function loadMedia(room: Room, media: RoomMedia, position: number, autoplay: boolean) {
  const s = room.state;
  s.media = media;
  s.position = Math.max(0, position);
  s.playing = autoplay;
  s.rate = 1;
  s.updatedAt = Date.now();
  // Everyone must load the new media before it starts (or the wait times out).
  startWaiting(room, connectedIds(room), LOAD_WAIT_MS);
  for (const c of room.conns.values()) { c.participant.ready = false; c.participant.sourceError = undefined; }
}

// ------------------------------------------------------------------ connections

export function handleConnection(ws: WebSocket) {
  let room: Room | null = null;
  let me: Conn | null = null;

  ws.on('message', (raw) => {
    let msg: ClientMessage;
    try { msg = JSON.parse(String(raw)); } catch { return; }

    if (msg.t === 'ping') return send(ws, { t: 'pong', c: msg.c, s: Date.now() });

    if (msg.t === 'hello') {
      const r = loadRoom(msg.roomId);
      if (!r) return send(ws, { t: 'error', code: 'not_found', message: 'This room does not exist (or was deleted).' });
      const member = db.prepare('SELECT token_hash FROM room_members WHERE room_id = ? AND user_id = ?').get(msg.roomId, msg.userId) as { token_hash: string } | undefined;
      const roomRow = db.prepare('SELECT key_hash, created_by FROM rooms WHERE id = ?').get(msg.roomId) as { key_hash: string; created_by: string };
      let token = msg.token;
      const tokenOk = !!(member && token && hash(token) === member.token_hash);
      const keyOk = !!(msg.key && hash(msg.key) === roomRow.key_hash);
      if (!tokenOk && !keyOk) return send(ws, { t: 'error', code: 'unauthorized', message: 'This is a private room. Ask for a fresh invitation link.' });
      if (!tokenOk) {
        token = randomId(18);
        db.prepare('INSERT INTO room_members (room_id, user_id, token_hash, joined_at) VALUES (?,?,?,?) ON CONFLICT(room_id, user_id) DO UPDATE SET token_hash=excluded.token_hash').run(msg.roomId, msg.userId, hash(token), Date.now());
      }
      room = r;
      const existing = room.conns.get(msg.userId);
      if (existing && existing.ws !== ws) { send(existing.ws, { t: 'error', code: 'replaced', message: 'You opened this room in another tab.' }); existing.ws.close(4000, 'replaced'); }
      const prior = room.known.get(msg.userId);
      const participant: Participant = {
        id: msg.userId, name: (msg.name || 'Guest').slice(0, 32), color: prior?.color ?? COLORS[room.known.size % COLORS.length],
        connected: true, buffering: false, ready: !room.state.media, lastSeen: Date.now(), media: prior?.media,
      };
      me = { ws, participant, ackSeq: -1 };
      room.conns.set(msg.userId, me);
      room.known.set(msg.userId, participant);
      if (!room.state.hostId) room.state.hostId = roomRow.created_by || msg.userId;
      // A joiner with media in progress must load first; hold others only if the room is configured to.
      if (room.state.media && room.state.settings.pauseOnBuffer && room.state.playing) {
        freeze(room.state, Date.now());
        startWaiting(room, [...room.state.waitingFor, msg.userId], LOAD_WAIT_MS);
        room.state.seq++;
        broadcastState(room);
      }
      send(ws, { t: 'welcome', you: msg.userId, token: token!, state: room.state, participants: participants(room), serverTime: Date.now() });
      broadcastParticipants(room);
      return;
    }

    if (!room || !me) return send(ws, { t: 'error', code: 'no_hello', message: 'Say hello first' });
    me.participant.lastSeen = Date.now();

    switch (msg.t) {
      case 'cmd': {
        const err = applyCommand(room, me.participant, msg.cmd);
        if (err) send(ws, { t: 'error', code: 'rejected', message: err });
        break;
      }
      case 'status': {
        const p = me.participant;
        const changed = p.buffering !== msg.buffering || p.ready !== msg.ready || p.sourceError !== msg.error;
        p.buffering = msg.buffering;
        p.ready = msg.ready;
        p.driftMs = msg.driftMs;
        p.rttMs = msg.rttMs;
        p.sourceError = msg.error;
        const s = room.state;
        const statusSeq = msg.seq;
        if (msg.ready && !msg.buffering && statusSeq >= s.seq && s.waitingFor.includes(p.id)) {
          s.waitingFor = s.waitingFor.filter((id) => id !== p.id);
          if (!s.waitingFor.length) releaseWait(room);
          else broadcastState(room);
        } else if (msg.buffering && s.playing && s.settings.pauseOnBuffer && !s.waitingFor.length && s.media && statusSeq >= s.seq) {
          freeze(s, Date.now());
          startWaiting(room, [p.id], BUFFER_WAIT_MS);
          s.seq++;
          s.lastAction = { by: p.id, byName: p.name, type: 'buffering', at: Date.now() };
          broadcastState(room);
        }
        if (changed) broadcastParticipants(room);
        break;
      }
      case 'rtc': {
        const target = room.conns.get(msg.to);
        if (target) send(target.ws, { t: 'rtc', from: me.participant.id, data: msg.data });
        break;
      }
      case 'media':
        me.participant.media = { mic: msg.mic, cam: msg.cam };
        broadcastParticipants(room);
        break;
      case 'chat':
        broadcast(room, { t: 'chat', from: me.participant.id, name: me.participant.name, text: String(msg.text).slice(0, 500), at: Date.now() });
        break;
    }
  });

  ws.on('close', () => {
    if (!room || !me) return;
    if (room.conns.get(me.participant.id) !== me) return; // replaced by a newer connection
    room.conns.delete(me.participant.id);
    me.participant.connected = false;
    me.participant.buffering = false;
    const s = room.state;
    if (s.waitingFor.includes(me.participant.id)) {
      s.waitingFor = s.waitingFor.filter((id) => id !== me!.participant.id);
      if (!s.waitingFor.length) releaseWait(room);
    }
    if (room.conns.size === 0) {
      // Last one out: freeze the room so everybody resumes from here later.
      freeze(s, Date.now());
      s.playing = false;
      s.seq++;
      persist(room, true);
    }
    broadcastParticipants(room);
  });
}

export function roomExists(id: string) {
  return !!db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(id);
}

export function persistAll() {
  for (const r of rooms.values()) persist(r, true);
}

