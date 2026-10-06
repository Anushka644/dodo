import fragSource from './note.frag?raw';
import { glslDefines } from '../note/layout';
import type { PlateName } from '../note/plates';

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

export type UniformValue = number | number[];

const SAMPLERS = ['tInk', 'tOvi', 'tUv', 'tWater', 'tBack', 'tRed', 'tPortrait', 'tMicro'] as const;
type Sampler = (typeof SAMPLERS)[number];

const PLATE_SAMPLER: Record<PlateName, Sampler> = {
  ink: 'tInk',
  ovi: 'tOvi',
  uv: 'tUv',
  water: 'tWater',
  back: 'tBack',
  red: 'tRed',
};

/** A deliberately small WebGL2 wrapper: one program, one triangle, a few textures. */
export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private locs = new Map<string, WebGLUniformLocation | null>();
  private textures = new Map<Sampler, WebGLTexture>();
  private portraitIsVideo = false;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;

    const src = `#version 300 es\n${glslDefines()}\n${fragSource}`;
    this.program = link(gl, compile(gl, gl.VERTEX_SHADER, VERT), compile(gl, gl.FRAGMENT_SHADER, src));
    gl.useProgram(this.program);

    // one oversized triangle covers the screen
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.program, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    SAMPLERS.forEach((name, unit) => {
      const tex = gl.createTexture()!;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      // 1×1 placeholder until the real plate arrives
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));
      gl.uniform1i(this.loc(name), unit);
      this.textures.set(name, tex);
    });
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  private loc(name: string) {
    if (!this.locs.has(name)) this.locs.set(name, this.gl.getUniformLocation(this.program, name));
    return this.locs.get(name)!;
  }

  private upload(sampler: Sampler, source: TexImageSource, opts: { single: boolean; repeat?: boolean }) {
    const gl = this.gl;
    const unit = SAMPLERS.indexOf(sampler);
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.get(sampler)!);
    if (opts.single) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, source);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, opts.repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 4);
  }

  setPlate(name: PlateName, canvas: HTMLCanvasElement) {
    this.upload(PLATE_SAMPLER[name], canvas, { single: true });
  }

  setMicro(canvas: HTMLCanvasElement) {
    this.upload('tMicro', canvas, { single: true, repeat: true });
  }

  setPortrait(source: HTMLCanvasElement | HTMLVideoElement) {
    this.portraitIsVideo = source instanceof HTMLVideoElement;
    this.upload('tPortrait', source, { single: false });
  }

  /** Pushes the newest camera frame, if the portrait is live. */
  refreshVideo(video: HTMLVideoElement) {
    if (!this.portraitIsVideo || video.readyState < 2) return;
    this.upload('tPortrait', video, { single: false });
  }

  resize(width: number, height: number) {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.gl.viewport(0, 0, width, height);
  }

  draw(uniforms: Record<string, UniformValue>) {
    const gl = this.gl;
    for (const [name, v] of Object.entries(uniforms)) {
      const l = this.loc(name);
      if (!l) continue;
      if (typeof v === 'number') gl.uniform1f(l, v);
      else if (v.length === 2) gl.uniform2fv(l, v);
      else if (v.length === 3) gl.uniform3fv(l, v);
      else if (v.length === 4) gl.uniform4fv(l, v);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
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
