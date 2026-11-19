import type { RoomClient } from '../sync/roomClient';

type Signal = { desc?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit; bye?: boolean; hello?: boolean };

const ICE: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

/**
 * Peer-to-peer voice/video for the people in a room (mesh — ideal for 2). Signalling rides on the room
 * WebSocket; media flows directly between browsers. Uses the "perfect negotiation" pattern so either side
 * can start or change tracks without glare. No TURN server is configured: very restrictive NATs may fail.
 */
export class CallManager {
  local: MediaStream | null = null;
  peers = new Map<string, { pc: RTCPeerConnection; stream: MediaStream; makingOffer: boolean; ignoreOffer: boolean; polite: boolean }>();
  mic = false;
  cam = false;
  private listeners = new Set<() => void>();
  private off: () => void;

  constructor(private room: RoomClient) {
    this.off = room.onRtc((from, data) => this.onSignal(from, data as Signal));
  }

  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit() { this.listeners.forEach((f) => f()); }
  get active() { return !!this.local; }

  async start(opts: { video: boolean; blur?: boolean }) {
    const constraints: MediaStreamConstraints = {
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: opts.video ? { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' } : false,
    };
    this.local = await navigator.mediaDevices.getUserMedia(constraints);
    const vt = this.local.getVideoTracks()[0];
    if (vt && opts.blur) {
      // Chrome 114+/Edge on supported hardware: platform background blur
      const caps = (vt.getCapabilities?.() ?? {}) as Record<string, unknown>;
      if ('backgroundBlur' in caps) await vt.applyConstraints({ advanced: [{ backgroundBlur: true } as any] }).catch(() => {});
    }
    this.mic = true;
    this.cam = !!vt;
    this.sendMediaState();
    for (const p of this.room.participants) {
      if (!p.connected || p.id === this.room.me) continue;
      const existing = this.peers.get(p.id);
      if (existing) this.local.getTracks().forEach((t) => existing.pc.addTrack(t, this.local!));
      else this.connect(p.id);
    }
    for (const p of this.room.participants) if (p.connected && p.id !== this.room.me) this.room.send({ t: 'rtc', to: p.id, data: { hello: true } });
    this.emit();
  }

  blurSupported() {
    const vt = this.local?.getVideoTracks()[0];
    return !!vt && 'backgroundBlur' in ((vt.getCapabilities?.() ?? {}) as Record<string, unknown>);
  }
  async setBlur(on: boolean) {
    const vt = this.local?.getVideoTracks()[0];
    if (vt) await vt.applyConstraints({ advanced: [{ backgroundBlur: on } as any] }).catch(() => {});
  }

  toggleMic() {
    this.mic = !this.mic;
    this.local?.getAudioTracks().forEach((t) => (t.enabled = this.mic));
    this.sendMediaState();
    this.emit();
  }
  async toggleCam() {
    if (!this.local) return;
    let vt = this.local.getVideoTracks()[0];
    if (!vt) {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 } } });
      vt = s.getVideoTracks()[0];
      this.local.addTrack(vt);
      for (const p of this.peers.values()) p.pc.addTrack(vt, this.local);
      this.cam = true;
    } else {
      this.cam = !this.cam;
      vt.enabled = this.cam;
    }
    this.sendMediaState();
    this.emit();
  }

  private sendMediaState() { this.room.send({ t: 'media', mic: this.mic && !!this.local, cam: this.cam && !!this.local }); }

  private connect(id: string) {
    if (this.peers.has(id)) return this.peers.get(id)!;
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const stream = new MediaStream();
    const peer = { pc, stream, makingOffer: false, ignoreOffer: false, polite: this.room.me < id };
    this.peers.set(id, peer);
    this.local?.getTracks().forEach((t) => pc.addTrack(t, this.local!));
    pc.ontrack = (e) => { e.streams[0]?.getTracks().forEach((t) => { if (!stream.getTracks().includes(t)) stream.addTrack(t); }); this.emit(); };
    pc.onicecandidate = (e) => e.candidate && this.room.send({ t: 'rtc', to: id, data: { candidate: e.candidate.toJSON() } });
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.room.send({ t: 'rtc', to: id, data: { desc: pc.localDescription!.toJSON() } });
      } finally { peer.makingOffer = false; }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') pc.restartIce();
      if (pc.connectionState === 'closed') { this.peers.delete(id); }
      this.emit();
    };
    this.emit();
    return peer;
  }

  private async onSignal(from: string, s: Signal) {
    if (s.bye) { this.peers.get(from)?.pc.close(); this.peers.delete(from); this.emit(); return; }
    if (s.hello) { if (this.local) this.connect(from); return; }
    if (!this.local && !this.peers.has(from)) {
      // Receive-only until the user joins the call themselves
      this.connect(from);
    }
    const peer = this.connect(from);
    const { pc } = peer;
    try {
      if (s.desc) {
        const collision = s.desc.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;
        await pc.setRemoteDescription(s.desc);
        if (s.desc.type === 'offer') {
          await pc.setLocalDescription();
          this.room.send({ t: 'rtc', to: from, data: { desc: pc.localDescription!.toJSON() } });
        }
      } else if (s.candidate) {
        try { await pc.addIceCandidate(s.candidate); } catch (e) { if (!peer.ignoreOffer) throw e; }
      }
    } catch (e) { console.warn('[rtc]', e); }
  }

  stop() {
    for (const [id, p] of this.peers) { this.room.send({ t: 'rtc', to: id, data: { bye: true } }); p.pc.close(); }
    this.peers.clear();
    this.local?.getTracks().forEach((t) => t.stop());
    this.local = null;
    this.mic = this.cam = false;
    this.sendMediaState();
    this.emit();
  }

  destroy() { this.stop(); this.off(); }
}
