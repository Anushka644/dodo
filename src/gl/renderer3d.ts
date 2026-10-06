import materialSrc from './material.glsl?raw';
import sheetFragSrc from './sheet.frag?raw';
import backdropSrc from './backdrop.frag?raw';
import { glslDefines } from '../note/layout';
import type { PlateName } from '../note/plates';

export type UniformValue = number | number[] | Float32Array;

const SHEET_VERT = `#version 300 es
in vec3 aPos;
in vec3 aNormal;
in vec2 aUv;
uniform mat4 uViewProj;
out vec3 vWorld;
out vec3 vNormal;
out vec2 vUv;
void main() {
  vWorld = aPos;
  vNormal = aNormal;
  vUv = aUv;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const FULLSCREEN_VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const SAMPLERS = ['tInk', 'tOvi', 'tUv', 'tWater', 'tBack', 'tRed', 'tPortrait', 'tMicro', 'tVideo'] as const;
type Sampler = (typeof SAMPLERS)[number];

const PLATE_SAMPLER: Record<PlateName, Sampler> = {
  ink: 'tInk',
  ovi: 'tOvi',
  uv: 'tUv',
  water: 'tWater',
  back: 'tBack',
  red: 'tRed',
};

export interface SheetDraw {
  id: number;
  cols: number;
  rows: number;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint16Array;
  uniforms: Record<string, UniformValue>;
}

class Program {
  readonly program: WebGLProgram;
  private locs = new Map<string, WebGLUniformLocation | null>();
  constructor(private gl: WebGL2RenderingContext, vert: string, frag: string) {
    this.program = link(gl, compile(gl, gl.VERTEX_SHADER, vert), compile(gl, gl.FRAGMENT_SHADER, frag));
  }
  loc(name: string) {
    if (!this.locs.has(name)) this.locs.set(name, this.gl.getUniformLocation(this.program, name));
    return this.locs.get(name)!;
  }
  set(uniforms: Record<string, UniformValue>) {
    const gl = this.gl;
    for (const name in uniforms) {
      const l = this.loc(name);
      if (!l) continue;
      const v = uniforms[name];
      if (typeof v === 'number') gl.uniform1f(l, v);
      else if (v.length === 16) gl.uniformMatrix4fv(l, false, v);
      else if (v.length === 2) gl.uniform2fv(l, v);
      else if (v.length === 3) gl.uniform3fv(l, v);
      else if (v.length === 4) gl.uniform4fv(l, v);
    }
  }
}

interface Mesh {
  vao: WebGLVertexArrayObject;
  pos: WebGLBuffer;
  nrm: WebGLBuffer;
  count: number;
}

/** WebGL2: one backdrop pass, then every sheet of paper as a mesh. */
export class Renderer3D {
  readonly gl: WebGL2RenderingContext;
  private sheet: Program;
  private backdrop: Program;
  private textures = new Map<Sampler, WebGLTexture>();
  private quad: WebGLVertexArrayObject;
  private meshes = new Map<number, Mesh>();
  private shared = new Map<string, { uv: WebGLBuffer; idx: WebGLBuffer; count: number }>();
  private videoReady = false;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      depth: true,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;

    const defines = glslDefines();
    const head = '#version 300 es\nprecision highp float;\nprecision highp sampler2D;\n';
    this.sheet = new Program(gl, SHEET_VERT, `${head}${defines}\n${materialSrc}\n${sheetFragSrc}`);
    this.backdrop = new Program(gl, FULLSCREEN_VERT, `#version 300 es\n${backdropSrc}`);

    // fullscreen triangle
    this.quad = gl.createVertexArray()!;
    gl.bindVertexArray(this.quad);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.backdrop.program, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    SAMPLERS.forEach((name, unit) => {
      const tex = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      this.textures.set(name, tex);
    });
    for (const p of [this.sheet, this.backdrop]) {
      gl.useProgram(p.program);
      SAMPLERS.forEach((name, unit) => {
        const l = p.loc(name);
        if (l) gl.uniform1i(l, unit);
      });
    }
  }

  private upload(sampler: Sampler, source: TexImageSource, opts: { single: boolean; repeat?: boolean; mips?: boolean }) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + SAMPLERS.indexOf(sampler));
    gl.bindTexture(gl.TEXTURE_2D, this.textures.get(sampler)!);
    if (opts.single) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, source);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    const mips = opts.mips !== false;
    if (mips) gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, opts.repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    if (aniso && opts.single) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
  }

  setPlate(name: PlateName, canvas: HTMLCanvasElement) {
    this.upload(PLATE_SAMPLER[name], canvas, { single: true });
  }

  setMicro(canvas: HTMLCanvasElement) {
    this.upload('tMicro', canvas, { single: true, repeat: true });
  }

  setPortrait(source: HTMLCanvasElement | HTMLVideoElement) {
    this.upload('tPortrait', source, { single: false });
  }

  /** the webcam, mirrored in the shader; mipmapped for blurred lookups */
  updateVideo(video: HTMLVideoElement | null) {
    if (!video || video.readyState < 2 || !video.videoWidth) {
      this.videoReady = false;
      return;
    }
    this.upload('tVideo', video, { single: false });
    this.videoReady = true;
  }

  get hasVideo() {
    return this.videoReady;
  }

  resize(width: number, height: number) {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.gl.viewport(0, 0, width, height);
  }

  private sharedFor(d: SheetDraw) {
    const key = `${d.cols}x${d.rows}`;
    let s = this.shared.get(key);
    if (!s) {
      const gl = this.gl;
      // element-array bindings live in whatever VAO is bound: unbind first
      gl.bindVertexArray(null);
      const uv = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, uv);
      gl.bufferData(gl.ARRAY_BUFFER, d.uvs, gl.STATIC_DRAW);
      const idx = gl.createBuffer()!;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, d.indices, gl.STATIC_DRAW);
      s = { uv, idx, count: d.indices.length };
      this.shared.set(key, s);
    }
    return s;
  }

  private meshFor(d: SheetDraw): Mesh {
    let m = this.meshes.get(d.id);
    if (m) return m;
    const gl = this.gl;
    const s = this.sharedFor(d);
    gl.bindVertexArray(null);
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const attr = (name: string, buf: WebGLBuffer, size: number) => {
      const l = gl.getAttribLocation(this.sheet.program, name);
      if (l < 0) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(l);
      gl.vertexAttribPointer(l, size, gl.FLOAT, false, 0, 0);
    };
    const pos = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, pos);
    gl.bufferData(gl.ARRAY_BUFFER, d.positions.byteLength, gl.DYNAMIC_DRAW);
    const nrm = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, nrm);
    gl.bufferData(gl.ARRAY_BUFFER, d.normals.byteLength, gl.DYNAMIC_DRAW);
    attr('aPos', pos, 3);
    attr('aNormal', nrm, 3);
    attr('aUv', s.uv, 2);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, s.idx);
    gl.bindVertexArray(null);
    m = { vao, pos, nrm, count: s.count };
    this.meshes.set(d.id, m);
    return m;
  }

  releaseSheet(id: number) {
    const m = this.meshes.get(id);
    if (!m) return;
    const gl = this.gl;
    gl.deleteVertexArray(m.vao);
    gl.deleteBuffer(m.pos);
    gl.deleteBuffer(m.nrm);
    this.meshes.delete(id);
  }

  frame(backdrop: Record<string, UniformValue>, globals: Record<string, UniformValue>, sheets: SheetDraw[]) {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.useProgram(this.backdrop.program);
    this.backdrop.set({ ...backdrop, uVideoOn: this.videoReady ? (backdrop.uVideoOn as number) : 0 });
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.depthFunc(gl.LEQUAL);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(this.sheet.program);
    this.sheet.set({ ...globals, uVideoOn: this.videoReady ? 1 : 0 });
    for (const d of sheets) {
      const m = this.meshFor(d);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.pos);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, d.positions);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.nrm);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, d.normals);
      this.sheet.set(d.uniforms);
      gl.bindVertexArray(m.vao);
      gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_SHORT, 0);
    }
    gl.bindVertexArray(null);
  }
}

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    const numbered = src.split('\n').map((l, i) => `${String(i + 1).padStart(4)}: ${l}`).join('\n');
    console.error(log, '\n', numbered);
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
