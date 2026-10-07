import worldSrc from './world.frag?raw';
import ditherSrc from './dither.frag?raw';
import { N, WORLD } from './terrain';

export type UniformValue = number | number[] | Float32Array;

export interface LandLayers {
  h: Float32Array;
  veg: Float32Array;
  heat: Float32Array;
  river: Float32Array;
}

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

class Program {
  readonly program: WebGLProgram;
  private locs = new Map<string, WebGLUniformLocation | null>();
  private types = new Map<string, number>();

  constructor(private gl: WebGL2RenderingContext, frag: string) {
    this.program = link(gl, compile(gl, gl.VERTEX_SHADER, VERT), compile(gl, gl.FRAGMENT_SHADER, frag));
    const n = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(this.program, i);
      if (info) this.types.set(info.name.replace(/\[0\]$/, ''), info.type);
    }
  }

  private loc(name: string) {
    if (!this.locs.has(name)) this.locs.set(name, this.gl.getUniformLocation(this.program, name));
    return this.locs.get(name)!;
  }

  set(uniforms: Record<string, UniformValue>) {
    const gl = this.gl;
    for (const name in uniforms) {
      const l = this.loc(name);
      if (!l) continue;
      const v = uniforms[name];
      const type = this.types.get(name);
      if (typeof v === 'number') {
        if (type === gl.SAMPLER_2D || type === gl.INT) gl.uniform1i(l, v);
        else gl.uniform1f(l, v);
        continue;
      }
      if (type === gl.FLOAT_VEC4) gl.uniform4fv(l, v);
      else if (type === gl.FLOAT_VEC3) gl.uniform3fv(l, v);
      else if (type === gl.FLOAT_VEC2) gl.uniform2fv(l, v);
      else gl.uniform1fv(l, v);
    }
  }
}

/** Two passes: the world at print resolution into a texture, then the dither to the screen. */
export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private world: Program;
  private dither: Program;
  private vao: WebGLVertexArrayObject;
  private height: WebGLTexture;
  private noise: WebGLTexture;
  private paper: WebGLTexture;
  private target: WebGLTexture;
  private fbo: WebGLFramebuffer;
  private size = [0, 0];

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    const defines = `#define WORLD ${WORLD.toFixed(2)}\n`;
    this.world = new Program(gl, `#version 300 es\n${defines}${worldSrc}`);
    this.dither = new Program(gl, `#version 300 es\n${ditherSrc}`);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    for (const p of [this.world, this.dither]) {
      const loc = gl.getAttribLocation(p.program, 'aPos');
      if (loc >= 0) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      }
    }

    // the land: half floats filter linearly everywhere WebGL2 runs
    this.height = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.height);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, N, N, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // the screen the print is made through: blue noise, so the grain is fine and even
    this.noise = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.noise);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, NOISE, NOISE, 0, gl.RED, gl.UNSIGNED_BYTE, blueNoise(NOISE));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

    // the sheet the print is pulled on: its tooth and the unevenness of the ink
    this.paper = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.paper);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, PAPER, PAPER, 0, gl.RG, gl.UNSIGNED_BYTE, paperTexture(PAPER));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

    this.target = gl.createTexture()!;
    this.fbo = gl.createFramebuffer()!;
  }

  private staging = new Float32Array(N * N * 4);

  /** upload the changed part of the land: height, vegetation, lava, rivers */
  uploadLand(land: LandLayers, rect: [number, number, number, number]) {
    const gl = this.gl;
    const [x0, y0, x1, y1] = rect;
    const w = x1 - x0 + 1;
    const hh = y1 - y0 + 1;
    const sub = this.staging.subarray(0, w * hh * 4);
    const { h, veg, heat, river } = land;
    for (let j = 0; j < hh; j++) {
      let o = j * w * 4;
      let k = (y0 + j) * N + x0;
      for (let i = 0; i < w; i++, k++, o += 4) {
        sub[o] = h[k];
        sub[o + 1] = veg[k];
        sub[o + 2] = heat[k];
        sub[o + 3] = river[k];
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, this.height);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, w, hh, gl.RGBA, gl.FLOAT, sub);
  }

  /** canvas in device pixels; the world renders at canvas / px */
  resize(width: number, height: number, px: number) {
    const gl = this.gl;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const tw = Math.max(1, Math.ceil(width / px));
    const th = Math.max(1, Math.ceil(height / px));
    if (this.size[0] !== tw || this.size[1] !== th) {
      this.size = [tw, th];
      gl.bindTexture(gl.TEXTURE_2D, this.target);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, tw, th, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.target, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  }

  get worldSize() {
    return this.size as [number, number];
  }

  draw(world: Record<string, UniformValue>, dither: Record<string, UniformValue>) {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.size[0], this.size[1]);
    gl.useProgram(this.world.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.height);
    this.world.set({ ...world, tHeight: 0, uRes: this.size });
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.dither.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.target);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.noise);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.paper);
    gl.activeTexture(gl.TEXTURE0);
    this.dither.set({ ...dither, tWorld: 0, tNoise: 1, tPaper: 2, uWorldRes: this.size });
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

const NOISE = 64;
const PAPER = 256;

/**
 * The paper, as a tiling texture (so the print pass pays two lookups for it,
 * not a stack of noise): R is the tooth — white noise the shader stretches
 * into fibres — and G a slow, soft mottle of ink density, 16 lumps across.
 */
function paperTexture(size: number): Uint8Array {
  let seed = 40503;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const lattice = (cells: number) => Float32Array.from({ length: cells * cells }, rnd);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const noise = (g: Float32Array, cells: number, u: number, v: number) => {
    const fx = u * cells, fy = v * cells;
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = smooth(fx - ix), ty = smooth(fy - iy);
    const at = (i: number, j: number) => g[(j % cells) * cells + (i % cells)];
    const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1);
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
  const m1 = lattice(16), m2 = lattice(52);
  const out = new Uint8Array(size * size * 2);
  for (let y = 0, o = 0; y < size; y++) {
    for (let x = 0; x < size; x++, o += 2) {
      const u = x / size, v = y / size;
      out[o] = Math.floor(rnd() * 256);
      out[o + 1] = Math.floor((noise(m1, 16, u, v) * 0.7 + noise(m2, 52, u, v) * 0.3) * 255.99);
    }
  }
  return out;
}

/**
 * A blue-noise threshold map by void-and-cluster (Ulichney, 1993): points are
 * ranked so that every prefix of them is spread as evenly as it can be. Used as
 * a dither screen, it gives a fine stochastic grain, like a riso's, with no
 * visible grid. Deterministic; about 20 ms for 64×64.
 */
function blueNoise(size: number): Uint8Array {
  const n = size * size, mask = size - 1;
  const R = 5, sigma = 1.6;
  const ker: number[] = [];
  for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) ker.push(Math.exp(-(x * x + y * y) / (2 * sigma * sigma)));
  const energy = new Float32Array(n);
  const on = new Uint8Array(n);
  const splat = (i: number, s: number) => {
    const x0 = i & mask, y0 = i >> Math.log2(size);
    let k = 0;
    for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++, k++) energy[((y0 + y) & mask) * size + ((x0 + x) & mask)] += s * ker[k];
  };
  const extreme = (want: number, max: boolean) => {
    let best = -1, bv = max ? -Infinity : Infinity;
    for (let i = 0; i < n; i++) {
      if (on[i] !== want) continue;
      const e = energy[i];
      if (max ? e > bv : e < bv) {
        bv = e;
        best = i;
      }
    }
    return best;
  };
  // a random start, then relax it: move the tightest cluster into the biggest void
  let seed = 22695477;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const ones = Math.floor(n / 10);
  for (let c = 0; c < ones; ) {
    const i = Math.floor(rnd() * n);
    if (!on[i]) {
      on[i] = 1;
      splat(i, 1);
      c++;
    }
  }
  for (let guard = 0; guard < n; guard++) {
    const c = extreme(1, true);
    on[c] = 0;
    splat(c, -1);
    const v = extreme(0, false);
    on[v] = 1;
    splat(v, 1);
    if (v === c) break;
  }
  const rank = new Uint16Array(n);
  const start = on.slice(), startE = energy.slice();
  // ranks below the start: take clusters away
  for (let r = ones - 1; r >= 0; r--) {
    const c = extreme(1, true);
    on[c] = 0;
    splat(c, -1);
    rank[c] = r;
  }
  // ranks above it: fill voids
  on.set(start);
  energy.set(startE);
  for (let r = ones; r < n; r++) {
    const v = extreme(0, false);
    on[v] = 1;
    splat(v, 1);
    rank[v] = r;
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(((rank[i] + 0.5) / n) * 256);
  return out;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    console.error(log, '\n', src.split('\n').map((l, i) => `${String(i + 1).padStart(4)}: ${l}`).join('\n'));
    throw new Error(`Shader failed to compile: ${log}`);
  }
  return s;
}

function link(gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader) {
  const p = gl.createProgram()!;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Program failed to link: ${gl.getProgramInfoLog(p)}`);
  return p;
}
