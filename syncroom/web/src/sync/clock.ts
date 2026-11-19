/**
 * NTP-style clock sync over the room WebSocket. offset = serverTime - localTime, estimated from the
 * lowest-RTT samples (least queueing delay → most accurate).
 */
export class ServerClock {
  private samples: { rtt: number; offset: number }[] = [];
  offset = 0;
  rtt = 0;

  sample(sentAt: number, serverTime: number, receivedAt: number) {
    const rtt = receivedAt - sentAt;
    if (rtt < 0 || rtt > 5000) return;
    this.samples.push({ rtt, offset: serverTime - (sentAt + rtt / 2) });
    if (this.samples.length > 16) this.samples.shift();
    const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, Math.max(1, Math.ceil(this.samples.length / 4)));
    this.offset = best.reduce((s, x) => s + x.offset, 0) / best.length;
    this.rtt = best[0].rtt;
  }
  get synced() { return this.samples.length >= 3; }
  now() { return Date.now() + this.offset; }
}
