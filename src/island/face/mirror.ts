// The mirror: the webcam, printed live through Paper Shaders' HalftoneDots
// shader, in the island's own key and paper. It's how you see what the camera
// sees, without a photo of you on the screen; and when you blow, it flies up
// into the sky as the wind head.
//
// Paper's ShaderMount takes images, not video, so it starts from a blank image
// of the right shape and then each new camera frame is uploaded into that same
// texture, and the mount is asked to draw.

import { ShaderMount, halftoneDotsFragmentShader, HalftoneDotsGrids, HalftoneDotsTypes, ShaderFitOptions } from '@paper-design/shaders';

type Rgb = [number, number, number];

interface MountInternals {
  gl: WebGL2RenderingContext;
  textures: Map<string, WebGLTexture>;
}

export class PaperMirror {
  private mount: ShaderMount;
  private raf = 0;
  private lastTime = -1;
  private disposed = false;
  private aspect = 0;

  private constructor(
    parent: HTMLElement,
    private video: HTMLVideoElement,
    seed: HTMLImageElement,
    ink: Rgb,
    paper: Rgb,
  ) {
    this.mount = new ShaderMount(
      parent,
      halftoneDotsFragmentShader,
      {
        u_image: seed,
        u_colorFront: [...ink, 1],
        u_colorBack: [...paper, 1],
        u_originalColors: false,
        u_inverted: false,
        u_type: HalftoneDotsTypes.classic,
        u_grid: HalftoneDotsGrids.hex,
        u_size: 0.42,
        u_radius: 1.25,
        u_contrast: 0.78,
        u_grainMixer: 0.15,
        u_grainOverlay: 0.08,
        u_grainSize: 0.5,
        u_fit: ShaderFitOptions.cover,
        u_scale: 1,
        u_rotation: 0,
        u_originX: 0.5,
        u_originY: 0.5,
        u_offsetX: 0,
        u_offsetY: 0,
        u_worldWidth: 0,
        u_worldHeight: 0,
      },
      { alpha: false, antialias: false, premultipliedAlpha: false },
      0,
    );
    this.aspect = seed.naturalWidth / seed.naturalHeight;
    this.loop();
  }

  static async create(parent: HTMLElement, video: HTMLVideoElement, ink: Rgb, paper: Rgb): Promise<PaperMirror> {
    // a blank image the shape of the video, for the mount to make its texture from
    const c = document.createElement('canvas');
    c.width = video.videoWidth || 640;
    c.height = video.videoHeight || 480;
    const g = c.getContext('2d')!;
    g.fillStyle = '#888';
    g.fillRect(0, 0, c.width, c.height);
    const img = new Image();
    img.src = c.toDataURL('image/png');
    await img.decode();
    return new PaperMirror(parent, video, img, ink, paper);
  }

  /** the island's inks, so the mirror prints in them as the day turns */
  setInks(ink: Rgb, paper: Rgb) {
    if (this.disposed) return;
    this.mount.setUniforms({ u_colorFront: [...ink, 1], u_colorBack: [...paper, 1] });
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const v = this.video;
    if (v.readyState < 2 || v.currentTime === this.lastTime) return;
    this.lastTime = v.currentTime;
    const { gl, textures } = this.mount as unknown as MountInternals;
    const tex = textures.get('u_image');
    if (!gl || !tex) return;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
    // a camera that changes shape (a phone turned on its side) keeps its proportions
    const ar = v.videoWidth / v.videoHeight;
    if (ar && Math.abs(ar - this.aspect) > 1e-3) {
      this.aspect = ar;
      const m = this.mount as unknown as { program: WebGLProgram; uniformLocations: Record<string, WebGLUniformLocation | null> };
      const loc = m.uniformLocations?.u_imageAspectRatio;
      if (loc) {
        gl.useProgram(m.program);
        gl.uniform1f(loc, ar);
      }
    }
    this.mount.setFrame(performance.now());
  };

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.mount.dispose();
  }
}
