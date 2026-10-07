import { sound } from '../sound';

// The island's sounds, all synthesised: the sea (louder as you come down to
// it), the ground groaning as you raise it, a pop when an egg hatches, and
// the dodo itself — a short, indignant, two-note honk.

class IslandSound {
  private sea: { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode; lfo: OscillatorNode } | null = null;
  private quake: { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode; osc: OscillatorNode; oscGain: GainNode } | null = null;

  wake() {
    const a = sound.audio;
    if (!a || this.sea) return;
    const { ctx, master, noise } = a;
    // the sea: brown-ish noise, swelling slowly like waves arriving
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 520;
    filter.Q.value = 0.4;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const swell = ctx.createGain();
    swell.gain.value = 0.6;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.11;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.4;
    lfo.connect(lfoGain).connect(swell.gain);
    src.connect(filter).connect(swell).connect(gain).connect(master);
    src.start();
    lfo.start();
    this.sea = { src, filter, gain, lfo };

    // the ground: low rumble, only while you sculpt
    const qsrc = ctx.createBufferSource();
    qsrc.buffer = noise;
    qsrc.loop = true;
    qsrc.playbackRate.value = 0.5;
    const qf = ctx.createBiquadFilter();
    qf.type = 'lowpass';
    qf.frequency.value = 140;
    const qg = ctx.createGain();
    qg.gain.value = 0;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 42;
    const og = ctx.createGain();
    og.gain.value = 0;
    qsrc.connect(qf).connect(qg).connect(master);
    osc.connect(og).connect(master);
    qsrc.start();
    osc.start();
    this.quake = { src: qsrc, filter: qf, gain: qg, osc, oscGain: og };
  }

  /** call every frame: closer to the water, louder; quieter at night */
  ambience(cameraDist: number, sunY: number) {
    const a = sound.audio;
    if (!a || !this.sea) return;
    const near = Math.min(1, Math.max(0, (16 - cameraDist) / 14));
    const t = a.ctx.currentTime;
    this.sea.gain.gain.setTargetAtTime(0.05 + near * 0.13 * (sunY < 0 ? 0.7 : 1), t, 0.3);
    this.sea.filter.frequency.setTargetAtTime(380 + near * 700, t, 0.3);
  }

  /** 1 raising, −1 carving, 0 still */
  rumble(dir: number) {
    const a = sound.audio;
    if (!a || !this.quake) return;
    const t = a.ctx.currentTime;
    const on = dir !== 0 ? 1 : 0;
    this.quake.gain.gain.setTargetAtTime(on * 0.5, t, on ? 0.08 : 0.2);
    this.quake.oscGain.gain.setTargetAtTime(on * 0.09, t, on ? 0.08 : 0.25);
    this.quake.osc.frequency.setTargetAtTime(dir > 0 ? 46 + Math.random() * 6 : 31 + Math.random() * 4, t, 0.05);
    this.quake.filter.frequency.setTargetAtTime(dir > 0 ? 170 : 110, t, 0.1);
  }

  private rainLoop: { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode } | null = null;

  /** call every frame with the rain's strength */
  rain(amount: number) {
    const a = sound.audio;
    if (!a) return;
    if (!this.rainLoop && amount > 0.01) {
      const { ctx, master, noise } = a;
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = 900;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(master);
      src.start();
      this.rainLoop = { src, filter, gain };
    }
    if (this.rainLoop) this.rainLoop.gain.gain.setTargetAtTime(amount * amount * 0.12, a.ctx.currentTime, 0.2);
  }

  private hiss: { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode } | null = null;
  private crackleAt = 0;

  /** new land coming up: steam hissing off it, and the crackle of rock cooling */
  lava(raising: number, glow: number) {
    const a = sound.audio;
    if (!a) return;
    const { ctx, master, noise } = a;
    if (!this.hiss && (raising > 0 || glow > 0.01)) {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      src.playbackRate.value = 1.3;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 3200;
      filter.Q.value = 0.7;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(master);
      src.start();
      this.hiss = { src, filter, gain };
    }
    if (!this.hiss) return;
    const t = ctx.currentTime;
    const level = Math.max(raising * 0.06, glow * 0.035);
    this.hiss.gain.gain.setTargetAtTime(level, t, raising ? 0.15 : 0.6);
    this.hiss.filter.frequency.setTargetAtTime(raising ? 2600 : 4200, t, 0.3);
    // crackles: little clicks of rock, more of them while it's hot
    const heat = Math.max(raising, glow);
    if (heat > 0.05 && t > this.crackleAt) {
      this.crackleAt = t + 0.03 + Math.random() * (0.25 / heat);
      const src = ctx.createBufferSource();
      src.buffer = noise;
      const f = ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = 1200 + Math.random() * 2400;
      const g = ctx.createGain();
      const loud = (0.04 + Math.random() * 0.08) * heat;
      g.gain.setValueAtTime(loud, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.012 + Math.random() * 0.02);
      src.connect(f).connect(g).connect(master);
      src.start(t, Math.random() * 1.5, 0.05);
    }
  }

  /** thunder rolls in after the flash; further away, later and softer */
  thunder(delay: number) {
    const a = sound.audio;
    if (!a) return;
    const { ctx, master, noise } = a;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.playbackRate.value = 0.35;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(420, t);
    f.frequency.exponentialRampToValueAtTime(90, t + 2.2);
    const g = ctx.createGain();
    const loud = 0.5 / (1 + delay);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(loud, t + 0.06);
    g.gain.exponentialRampToValueAtTime(loud * 0.4, t + 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.6);
    src.connect(f).connect(g).connect(master);
    src.start(t, Math.random() * 0.5, 2.8);
  }

  /** a seabird, somewhere overhead: a few falling, scratchy cries */
  cry(cameraDist: number) {
    const a = sound.audio;
    if (!a) return;
    const { ctx, master } = a;
    const loud = 0.03 * Math.min(1, Math.max(0.25, (14 - cameraDist) / 10));
    const n = 2 + Math.floor(Math.random() * 3);
    const base = 1500 + Math.random() * 600;
    for (let i = 0; i < n; i++) {
      const t = ctx.currentTime + i * (0.16 + Math.random() * 0.06);
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(base * (1 + Math.random() * 0.08), t);
      o.frequency.exponentialRampToValueAtTime(base * 0.62, t + 0.12);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2400;
      bp.Q.value = 2;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(loud, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      o.connect(bp).connect(g).connect(master);
      o.start(t);
      o.stop(t + 0.16);
    }
  }

  /** a gust: air moving, low to high */
  whoosh() {
    const a = sound.audio;
    if (!a) return;
    const { ctx, master, noise } = a;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.2;
    f.frequency.setValueAtTime(260, t);
    f.frequency.exponentialRampToValueAtTime(1300, t + 0.55);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.14, t + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    src.connect(f).connect(g).connect(master);
    src.start(t, Math.random() * 1.5, 0.9);
  }

  private windLoop: { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode } | null = null;

  /** call every frame with the wind's strength: a moving band of air, rising as it blows harder */
  wind(amount: number) {
    const a = sound.audio;
    if (!a) return;
    if (!this.windLoop && amount > 0.01) {
      const { ctx, master, noise } = a;
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      src.playbackRate.value = 0.7;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.Q.value = 1.6;
      filter.frequency.value = 400;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(master);
      src.start();
      this.windLoop = { src, filter, gain };
    }
    if (!this.windLoop) return;
    const t = a.ctx.currentTime;
    this.windLoop.gain.gain.setTargetAtTime(amount * 0.16, t, 0.25);
    // gusts: the band wanders
    this.windLoop.filter.frequency.setTargetAtTime(380 + amount * 700 + Math.sin(t * 1.7) * 120 * amount, t, 0.3);
  }

  /** an egg cracks somewhere on the island */
  hatch() {
    const a = sound.audio;
    if (!a) return;
    const { ctx, master } = a;
    const t = ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(900 + i * 260, t + i * 0.05);
      o.frequency.exponentialRampToValueAtTime(420, t + i * 0.05 + 0.06);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + i * 0.05);
      g.gain.exponentialRampToValueAtTime(0.06, t + i * 0.05 + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.05 + 0.08);
      o.connect(g).connect(master);
      o.start(t + i * 0.05);
      o.stop(t + i * 0.05 + 0.1);
    }
    window.setTimeout(() => this.honk(1.35), 260);
  }

  /** the dodo: a nasal two-note "hoo-onk" (pitch 1 = an adult) */
  honk(pitch = 1) {
    const a = sound.audio;
    if (!a) return;
    const { ctx, master } = a;
    const t = ctx.currentTime;
    const notes: [number, number, number][] = [
      [0, 0.09, 330],
      [0.11, 0.17, 262],
    ];
    for (const [at, dur, f] of notes) {
      const carrier = ctx.createOscillator();
      carrier.type = 'sawtooth';
      carrier.frequency.setValueAtTime(f * pitch * 1.06, t + at);
      carrier.frequency.exponentialRampToValueAtTime(f * pitch * 0.92, t + at + dur);
      // a wobble in the throat
      const mod = ctx.createOscillator();
      mod.frequency.value = 28;
      const modGain = ctx.createGain();
      modGain.gain.value = f * pitch * 0.04;
      mod.connect(modGain).connect(carrier.frequency);
      // nasal formant
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1100 * pitch;
      bp.Q.value = 3.5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + at);
      g.gain.exponentialRampToValueAtTime(0.16, t + at + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
      carrier.connect(bp).connect(g).connect(master);
      carrier.start(t + at);
      mod.start(t + at);
      carrier.stop(t + at + dur + 0.02);
      mod.stop(t + at + dur + 0.02);
    }
  }
}

export const islandSound = new IslandSound();
