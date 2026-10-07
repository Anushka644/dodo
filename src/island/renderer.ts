import worldSrc from './world.frag?raw';
import ditherSrc from './dither.frag?raw';
import { N, WORLD } from './terrain';

export type UniformValue = number | number[] | Float32Array;

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

    // the heightmap: half floats filter linearly everywhere WebGL2 runs
    this.height = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.height);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, N, N, 0, gl.RG, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.target = gl.createTexture()!;
    this.fbo = gl.createFramebuffer()!;
  }

  /** upload the changed part of the land: height in R, vegetation in G */
  uploadLand(h: Float32Array, veg: Float32Array, rect: [number, number, number, number]) {
    const gl = this.gl;
    const [x0, y0, x1, y1] = rect;
    const w = x1 - x0 + 1;
    const hh = y1 - y0 + 1;
    const sub = new Float32Array(w * hh * 2);
    for (let j = 0; j < hh; j++) {
      for (let i = 0; i < w; i++) {
        const k = (y0 + j) * N + x0 + i;
        sub[(j * w + i) * 2] = h[k];
        sub[(j * w + i) * 2 + 1] = veg[k];
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, this.height);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, w, hh, gl.RG, gl.FLOAT, sub);
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
    this.dither.set({ ...dither, tWorld: 0, uWorldRes: this.size });
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
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
