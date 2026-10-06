import { sound } from './sound';
import type { PaperSoundsApi } from './contracts';

// Paper and money, synthesised. Two loops (flutter, the counting machine)
// that are steered every frame, and a few one-shots. All quiet.

type Loop = { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode; lfo?: OscillatorNode; lfoGain?: GainNode };

class PaperSounds implements PaperSoundsApi {
  private flutterLoop: Loop | null = null;
  private counterLoop: Loop | null = null;
  private lastCrumple = 0;

  private loop(kind: 'flutter' | 'counter'): Loop | null {
    const a = sound.audio;
    if (!a) return null;
    const { ctx, master, noise } = a;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    // amplitude modulation: flapping paper, or the machine's ticks
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    if (kind === 'flutter') {
      filter.type = 'bandpass';
      filter.frequency.value = 1800;
      filter.Q.value = 0.8;
      lfo.type = 'triangle';
      lfo.frequency.value = 14;
    } else {
      filter.type = 'highpass';
      filter.frequency.value = 2600;
      lfo.type = 'square';
      lfo.frequency.value = 30;
    }
    lfoGain.gain.value = 0;
    const am = ctx.createGain();
    am.gain.value = 0.5;
    lfo.connect(lfoGain).connect(am.gain);
    src.connect(filter).connect(am).connect(gain).connect(master);
    src.start();
    lfo.start();
    return { src, filter, gain, lfo, lfoGain };
  }

  flutter(speed: number) {
    const a = sound.audio;
    if (!a) return;
    const level = Math.min(1, Math.max(0, (speed - 0.4) / 3));
    if (!this.flutterLoop && level > 0.01) this.flutterLoop = this.loop('flutter');
    const l = this.flutterLoop;
    if (!l) return;
    const t = a.ctx.currentTime;
    l.gain.gain.setTargetAtTime(level * 0.12, t, 0.08);
    l.filter.frequency.setTargetAtTime(1200 + level * 2600, t, 0.1);
    l.lfo!.frequency.setTargetAtTime(9 + level * 14 + Math.random() * 4, t, 0.05);
    l.lfoGain!.gain.setTargetAtTime(0.45, t, 0.1);
  }

  counter(intensity: number) {
    const a = sound.audio;
    if (!a) return;
    if (!this.counterLoop && intensity > 0.01) this.counterLoop = this.loop('counter');
    const l = this.counterLoop;
    if (!l) return;
    const t = a.ctx.currentTime;
    l.gain.gain.setTargetAtTime(intensity > 0.01 ? 0.05 + intensity * 0.09 : 0, t, intensity > 0.01 ? 0.03 : 0.06);
    l.lfo!.frequency.setTargetAtTime(24 + intensity * 12 + Math.random() * 3, t, 0.04);
    l.lfoGain!.gain.setTargetAtTime(0.5, t, 0.05);
  }

  private burst(dur: number, freq: number, q: number, level: number, type: BiquadFilterType = 'bandpass', at = 0) {
    const a = sound.audio;
    if (!a) return;
    const { ctx, master, noise } = a;
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t, Math.random() * 0.5, dur + 0.05);
    src.onended = () => g.disconnect();
  }

  grab() {
    for (let i = 0; i < 3; i++) this.burst(0.04 + Math.random() * 0.04, 3000 + Math.random() * 3000, 1.2, 0.09, 'bandpass', i * 0.018);
  }

  release() {
    this.burst(0.18, 1400, 0.6, 0.05, 'bandpass');
  }

  catchNote() {
    this.burst(0.07, 500, 0.7, 0.14, 'lowpass');
    this.burst(0.05, 2600, 1, 0.04, 'bandpass', 0.01);
  }

  crumple(amount: number) {
    const now = performance.now();
    if (now - this.lastCrumple < 40 + (1 - amount) * 80) return;
    this.lastCrumple = now;
    const n = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) this.burst(0.015 + Math.random() * 0.03, 2500 + Math.random() * 5000, 2, 0.05 + amount * 0.08, 'bandpass', i * 0.012);
  }

  snap() {
    this.burst(0.03, 4200, 1.5, 0.2, 'bandpass');
    this.burst(0.12, 900, 0.8, 0.06, 'lowpass', 0.005);
  }
}

export const paperSound = new PaperSounds();
