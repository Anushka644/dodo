import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Engine, TOOLS, type Tool } from './engine';
import { sound } from './sound';
import { DEFAULT_NAME } from './note/seed';

const COPY: Record<Tool, { name: string; short: string; spec: string; line: string; key: string }> = {
  lamp: {
    name: 'Lamp',
    short: 'Lamp',
    spec: 'Raking light · 3200 K',
    line: 'Intaglio ink sits raised on the paper. Lower the lamp and the relief catches.',
    key: '1',
  },
  loupe: {
    name: 'Loupe',
    short: 'Loupe',
    spec: '×5 · LED ring',
    line: 'The thin lines aren’t lines. Read them.',
    key: '2',
  },
  uv: {
    name: 'Ultraviolet',
    short: 'UV',
    spec: 'UV-A · 365 nm',
    line: 'Real banknote paper stays dark. The things meant to glow, glow.',
    key: '3',
  },
  back: {
    name: 'Backlight',
    short: 'Backlit',
    spec: 'Transmitted light',
    line: 'Hold it up to the window. The paper itself has a portrait.',
    key: '4',
  },
};

const HINTS: Record<Tool, [string, string]> = {
  // [pointer, touch]
  lamp: ['Move the lamp · scroll to raise or lower it', 'Drag to move the lamp'],
  loupe: ['Move the loupe · scroll to change magnification', 'Drag the loupe over the note'],
  uv: ['Sweep the blacklight across the note', 'Drag the blacklight across the note'],
  back: ['Move the light behind the paper', 'Drag the light behind the paper'],
};

const coarse = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [tool, setToolState] = useState<Tool>('lamp');
  const [name, setName] = useState('');
  const [serial, setSerial] = useState('');
  const [touched, setTouched] = useState(false);
  const [camera, setCamera] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    let engine: Engine;
    try {
      engine = new Engine(canvas);
    } catch {
      setFailed(true);
      return;
    }
    engineRef.current = engine;
    engine.onInteract = () => setTouched(true);
    engine.init().then(() => {
      setSerial(engine.issue.serial);
      setReady(true);
      document.body.dataset.ready = '1';
    });
    const onResize = () => engine.layout();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      engine.dispose();
    };
  }, []);

  const pickTool = useCallback((t: Tool) => {
    sound.wake();
    engineRef.current?.setTool(t);
    setToolState(t);
  }, []);

  // keyboard: 1–4 for tools, arrows to steer the lamp
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.tagName === 'INPUT';
      if (typing) {
        if (e.key === 'Escape' || e.key === 'Enter') (e.target as HTMLElement).blur();
        return;
      }
      const i = ['1', '2', '3', '4'].indexOf(e.key);
      if (i >= 0) pickTool(TOOLS[i]);
      const step = e.shiftKey ? 40 : 12;
      const arrows: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      if (arrows[e.key]) {
        e.preventDefault();
        engineRef.current?.nudge(...arrows[e.key]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickTool]);

  const onPointer = (e: React.PointerEvent) => {
    engineRef.current?.pointerMove(e.clientX, e.clientY, e.pointerType === 'touch');
  };

  useEffect(() => {
    const canvas = canvasRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      engineRef.current?.wheel(e.deltaY);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  const onName = (v: string) => {
    sound.wake();
    setName(v);
    engineRef.current?.setName(v);
    setSerial(engineRef.current?.issue.serial ?? '');
  };

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3200);
  };

  const toggleCamera = async () => {
    const engine = engineRef.current;
    if (!engine) return;
    sound.wake();
    sound.click();
    if (engine.cameraOn) {
      engine.stopCamera();
      setCamera(false);
      return;
    }
    const ok = await engine.startCamera();
    setCamera(ok);
    flash(ok ? 'Hold still. You’re being engraved.' : 'No camera, so the dodo sits for you.');
  };

  const save = async () => {
    const engine = engineRef.current;
    if (!engine) return;
    sound.wake();
    sound.press();
    const blob = await engine.capture();
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `dodo-reserve-${engine.issue.serial.replace(/\s+/g, '')}.png`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    flash('Printed. Spend it wisely.');
  };

  const toggleSound = () => {
    const next = !soundOn;
    sound.wake();
    sound.setEnabled(next);
    setSoundOn(next);
  };

  const copy = COPY[tool];

  return (
    <div className={`app tool-${tool} ${ready ? 'is-ready' : ''}`}>
      <canvas
        ref={canvasRef}
        className="stage"
        onPointerMove={onPointer}
        onPointerDown={(e) => {
          sound.wake();
          onPointer(e);
        }}
        aria-label="A banknote under a lamp. Move the pointer to move the light."
        role="img"
      />

      <header className="masthead">
        <div className="wordmark">Specimen</div>
        <div className="sub mono">The Dodo Reserve · No.&nbsp;001</div>
      </header>

      <section className="label" aria-live="polite">
        <div key={tool} className="label-inner">
          <div className="mono label-spec">
            <span className="led" /> {copy.spec}
          </div>
          <p className="label-line">{copy.line}</p>
        </div>
      </section>

      <div className={`hint mono ${touched ? 'is-transient' : ''}`} key={`hint-${tool}`}>
        {HINTS[tool][coarse ? 1 : 0]}
      </div>

      <footer className="dock">
        <label className="bearer">
          <span className="mono bearer-label">Issued to</span>
          <input
            value={name}
            onChange={(e) => onName(e.target.value)}
            placeholder={DEFAULT_NAME}
            maxLength={28}
            spellCheck={false}
            autoComplete="off"
            aria-label="Name on the note"
          />
          <span className="mono bearer-serial" aria-label="Serial number">
            {serial}
          </span>
        </label>

        <Tools tool={tool} onPick={pickTool} />

        <div className="actions">
          <button className={`icon-btn ${camera ? 'is-on' : ''}`} onClick={toggleCamera} title="Sit for the portrait (camera)">
            <IconCamera />
            <span className="mono">{camera ? 'Dodo' : 'Sit'}</span>
          </button>
          <button className="icon-btn" onClick={save} title="Keep this note (PNG)">
            <IconSave />
            <span className="mono">Keep</span>
          </button>
          <button className="icon-btn" onClick={toggleSound} title={soundOn ? 'Mute' : 'Sound on'} aria-pressed={soundOn}>
            {soundOn ? <IconSound /> : <IconMute />}
          </button>
        </div>
      </footer>

      {toast && <div className="toast mono">{toast}</div>}
      {failed && (
        <div className="fallback">
          <p>This toy needs WebGL2, which this browser doesn&rsquo;t offer. Try a recent Chrome, Safari or Firefox.</p>
        </div>
      )}
    </div>
  );
}

function Tools({ tool, onPick }: { tool: Tool; onPick: (t: Tool) => void }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [pill, setPill] = useState({ x: 0, w: 0 });

  // the selection pill slides between tools rather than jumping
  useLayoutEffect(() => {
    const measure = () => {
      const el = refs.current[tool];
      if (el) setPill({ x: el.offsetLeft, w: el.offsetWidth });
    };
    measure();
    // labels change width once the webfonts land
    document.fonts?.ready.then(measure);
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [tool]);

  return (
    <div className="tools" role="radiogroup" aria-label="Inspection light">
      <span className="tools-pill" style={{ transform: `translateX(${pill.x}px)`, width: pill.w }} />
      {TOOLS.map((t) => (
        <button
          key={t}
          ref={(el) => {
            refs.current[t] = el;
          }}
          role="radio"
          aria-checked={tool === t}
          className={`tool ${tool === t ? 'is-active' : ''}`}
          onClick={() => onPick(t)}
        >
          <ToolIcon tool={t} />
          <span className="tool-name">{COPY[t].name}</span>
          <span className="tool-short">{COPY[t].short}</span>
          <kbd className="mono">{COPY[t].key}</kbd>
        </button>
      ))}
    </div>
  );
}

function ToolIcon({ tool }: { tool: Tool }) {
  const common = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  switch (tool) {
    case 'lamp':
      return (
        <svg {...common}>
          <path d="M6 9 L12 3 L18 9 Z" />
          <path d="M12 9 v4" />
          <path d="M8 16 l-2 4 M12 16 v5 M16 16 l2 4" opacity="0.6" />
        </svg>
      );
    case 'loupe':
      return (
        <svg {...common}>
          <circle cx="10.5" cy="10.5" r="6" />
          <path d="M15 15 l5 5" />
          <path d="M8 9 a3 3 0 0 1 3 -2" opacity="0.6" />
        </svg>
      );
    case 'uv':
      return (
        <svg {...common}>
          <rect x="4" y="9" width="16" height="6" rx="3" />
          <path d="M7 5 l1 2 M12 4 v2.5 M17 5 l-1 2 M7 19 l1 -2 M12 20 v-2.5 M17 19 l-1 -2" opacity="0.7" />
        </svg>
      );
    case 'back':
      return (
        <svg {...common}>
          <rect x="5" y="4" width="14" height="16" rx="1" />
          <circle cx="12" cy="12" r="3.2" opacity="0.7" />
        </svg>
      );
  }
}

const icon = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

function IconCamera() {
  return (
    <svg {...icon}>
      <path d="M4 8 h3 l2 -2.5 h6 l2 2.5 h3 v11 H4 Z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

function IconSave() {
  return (
    <svg {...icon}>
      <path d="M12 4 v11 M7.5 10.5 L12 15 l4.5 -4.5" />
      <path d="M5 19 h14" />
    </svg>
  );
}

function IconSound() {
  return (
    <svg {...icon}>
      <path d="M5 10 h3 l4 -4 v12 l-4 -4 H5 Z" />
      <path d="M15.5 9.5 a3.5 3.5 0 0 1 0 5 M18 7 a7 7 0 0 1 0 10" />
    </svg>
  );
}

function IconMute() {
  return (
    <svg {...icon}>
      <path d="M5 10 h3 l4 -4 v12 l-4 -4 H5 Z" />
      <path d="M16 10 l4 4 M20 10 l-4 4" />
    </svg>
  );
}
