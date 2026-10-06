// Every sound is synthesised on the spot — no files. Quiet on purpose:
// they should feel like the room, not like an app.

class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private hum: { osc: OscillatorNode; gain: GainNode } | null = null;
  private noise: AudioBuffer | null = null;
  enabled = true;

  /** Browsers only allow audio after a gesture; call this from one. */
  wake() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.enabled ? 0.55 : 0;
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  /** shared graph for other sound modules (null until a gesture wakes audio) */
  get audio(): { ctx: AudioContext; master: GainNode; noise: AudioBuffer } | null {
    return this.ctx && this.master && this.noise ? { ctx: this.ctx, master: this.master, noise: this.noise } : null;
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(on ? 0.55 : 0, this.ctx.currentTime, 0.05);
  }

  private burst(dur: number, freq: number, q: number, gain: number, type: BiquadFilterType = 'bandpass', at = 0) {
    if (!this.ctx || !this.master || !this.noise) return;
    const t = this.ctx.currentTime + at;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5, dur + 0.05);
  }

  private tone(freq: number, dur: number, gain: number, type: OscillatorType = 'sine', at = 0) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime + at;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 0.6, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  /** a desk-lamp switch */
  click() {
    this.burst(0.03, 3200, 2, 0.22);
    this.tone(140, 0.05, 0.12, 'triangle');
  }

  /** the numbering machine advancing a digit */
  tick() {
    this.burst(0.018, 5200, 4, 0.08);
    this.tone(900 + Math.random() * 200, 0.02, 0.03, 'square');
  }

  /** the press coming down */
  press() {
    this.tone(70, 0.25, 0.35, 'sine');
    this.burst(0.12, 600, 0.8, 0.15, 'lowpass');
  }

  glass() {
    this.tone(2400, 0.12, 0.03, 'sine');
    this.tone(3600, 0.08, 0.015, 'sine', 0.01);
  }

  rustle() {
    for (let i = 0; i < 4; i++) this.burst(0.09 + Math.random() * 0.08, 2500 + Math.random() * 2500, 0.7, 0.07, 'bandpass', i * 0.045);
  }

  crackle() {
    this.burst(0.012, 6000, 1, 0.05, 'highpass');
  }

  /** a blacklight ballast: a low, slightly rough hum */
  uvOn() {
    if (!this.ctx || !this.master || this.hum) return;
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = 100;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 340;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    g.gain.setTargetAtTime(0.03, this.ctx.currentTime + 0.4, 0.2);
    o.connect(f).connect(g).connect(this.master);
    o.start();
    this.hum = { osc: o, gain: g };
  }

  uvOff() {
    if (!this.ctx || !this.hum) return;
    const { osc, gain } = this.hum;
    gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    osc.stop(this.ctx.currentTime + 0.3);
    this.hum = null;
  }
}

export const sound = new Sound();
