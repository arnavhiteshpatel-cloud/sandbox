/** Inspection voice and subtle audio feedback (all offline: system speech + WebAudio). */
let ctx: AudioContext | null = null;

export function beep(freq = 880, ms = 120, gain = 0.06) {
  try {
    ctx ??= new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = freq;
    g.gain.value = 0;
    g.gain.linearRampToValueAtTime(gain, ctx.currentTime + 0.01);
    g.gain.linearRampToValueAtTime(0, ctx.currentTime + ms / 1000);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + ms / 1000 + 0.02);
  } catch {
    /* audio unavailable */
  }
}

export function speak(text: string) {
  try {
    const synth = window.speechSynthesis;
    if (!synth) return false;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    u.volume = 0.9;
    synth.speak(u);
    return true;
  } catch {
    return false;
  }
}

export function inspectionWarning(sec: 8 | 12, voice: boolean, sound: boolean) {
  if (voice) speak(sec === 8 ? "Eight seconds" : "Twelve seconds");
  if (sound) beep(sec === 8 ? 740 : 990, 140);
}
