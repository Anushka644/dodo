import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Engine, type HudState } from './engine';
import { sound } from './sound';
import { DEFAULT_NAME } from './note/seed';
import type { Pose } from './contracts';

type Gesture = { pose: Pose; name: string; does: string; icon: ReactNode; keys?: string };

const HAND_GESTURES: Gesture[] = [
  { pose: 'open', name: 'Open hand', does: 'catch it', icon: <IconOpen /> },
  { pose: 'pinch', name: 'Pinch', does: 'hold · flick to throw', icon: <IconPinch /> },
  { pose: 'fist', name: 'Fist', does: 'crumple', icon: <IconFist /> },
  { pose: 'point', name: 'Point', does: 'UV torch', icon: <IconPoint /> },
  { pose: 'rub', name: 'Rub fingers', does: 'print money', icon: <IconRub /> },
];

const MOUSE_GESTURES: Gesture[] = [
  { pose: 'pinch', name: 'Drag', does: 'hold · fling', icon: <IconPinch />, keys: 'drag' },
  { pose: 'fist', name: 'Hold C', does: 'crumple', icon: <IconFist />, keys: 'C' },
  { pose: 'point', name: 'Hold Shift', does: 'UV torch', icon: <IconPoint />, keys: '⇧' },
  { pose: 'rub', name: 'Hold Space', does: 'print money', icon: <IconRub />, keys: '␣' },
];

const coarse = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [hud, setHud] = useState<HudState>({
    mode: 'intro',
    hands: 0,
    poses: [],
    printed: 0,
    tracking: 'off',
    loadingMsg: '',
    holding: false,
  });
  const [name, setName] = useState('');
  const [soundOn, setSoundOn] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef(0);

  const flash = (msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3400);
  };

  useEffect(() => {
    const canvas = canvasRef.current!;
    let engine: Engine;
    try {
      engine = new Engine(canvas);
    } catch (e) {
      console.error(e);
      setFailed(true);
      return;
    }
    engineRef.current = engine;
    engine.overlay = overlayRef.current!.getContext('2d');
    engine.onHud = setHud;
    engine.init().then(() => {
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

  // keys stand in for the gestures when there's no camera
  useEffect(() => {
    const set = (e: KeyboardEvent, on: boolean) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') {
        if (on && (e.key === 'Escape' || e.key === 'Enter')) (e.target as HTMLElement).blur();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const engine = engineRef.current;
      if (!engine) return;
      if (e.code === 'Space') {
        e.preventDefault();
        engine.setPrinting(on);
      } else if (e.key === 'Shift') engine.setTorch(on);
      else if (e.key === 'c' || e.key === 'C') engine.setCrumple(on);
      else if (on && (e.key === 'r' || e.key === 'R')) engine.summon();
    };
    const down = (e: KeyboardEvent) => set(e, true);
    const up = (e: KeyboardEvent) => set(e, false);
    const blur = () => {
      engineRef.current?.setPrinting(false);
      engineRef.current?.setTorch(false);
      engineRef.current?.setCrumple(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      engineRef.current?.wheel(e.deltaY);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    if (hud.tracking === 'error' && hud.loadingMsg) flash(hud.loadingMsg);
  }, [hud.tracking, hud.loadingMsg]);

  const useHands = async () => {
    sound.wake();
    sound.click();
    const ok = await engineRef.current?.startCamera();
    if (ok) flash('Show the camera your open hand.');
  };

  const useMouse = () => {
    sound.wake();
    sound.click();
    engineRef.current?.useMouse();
    flash(coarse ? 'Drag the note. Hold the buttons to print or shine UV.' : 'Drag the note. Hold Space to print money.');
  };

  const toggleCamera = () => {
    const engine = engineRef.current;
    if (!engine) return;
    if (hud.tracking === 'on' || hud.tracking === 'loading') {
      engine.stopCamera();
      engine.useMouse();
    } else void useHands();
  };

  const onName = (v: string) => {
    sound.wake();
    setName(v);
    engineRef.current?.setName(v);
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
    flash('Saved. Spend it wisely.');
  };

  const toggleSound = () => {
    const next = !soundOn;
    sound.wake();
    sound.setEnabled(next);
    setSoundOn(next);
  };

  const pointer = (e: React.PointerEvent, down: boolean | null) => {
    if (e.button === 2 && down !== null) {
      engineRef.current?.setTorch(down);
      return;
    }
    if (down) sound.wake();
    engineRef.current?.pointer(e.clientX, e.clientY, down);
  };

  const intro = hud.mode === 'intro';
  const camera = hud.mode === 'camera';
  const legend = camera ? HAND_GESTURES : MOUSE_GESTURES;
  const active = new Set(hud.poses);
  const circulation = hud.printed + 1;
  const inflation = hud.printed * 100;

  return (
    <div className={`app mode-${hud.mode} ${ready ? 'is-ready' : ''} ${active.has('point') ? 'is-uv' : ''}`}>
      <canvas
        ref={canvasRef}
        className="stage"
        onPointerMove={(e) => pointer(e, null)}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          pointer(e, true);
        }}
        onPointerUp={(e) => pointer(e, false)}
        onPointerCancel={(e) => pointer(e, false)}
        onPointerLeave={() => engineRef.current?.pointerLeave()}
        onContextMenu={(e) => e.preventDefault()}
        onDoubleClick={() => engineRef.current?.summon()}
        aria-label="A banknote of the Dodo Reserve. Hold it with your hand on camera, or drag it with the pointer."
        role="img"
      />
      <canvas ref={overlayRef} className="overlay" aria-hidden />

      <header className="masthead">
        <div className="wordmark">Specimen</div>
        <div className="sub mono">The Dodo Reserve · money you can hold</div>
      </header>

      <section className="supply mono" aria-live="polite">
        <div className="supply-row">
          <span className="supply-label">In circulation</span>
          <span className="supply-value">
            {circulation.toLocaleString()} <span className="supply-unit">DODO</span>
          </span>
        </div>
        <div className={`supply-row inflation ${hud.printed > 0 ? 'is-on' : ''}`}>
          <span className="supply-label">Inflation</span>
          <span className="supply-value">{inflation.toLocaleString()}%</span>
        </div>
      </section>

      {intro && ready && (
        <section className="invite" role="dialog" aria-label="How do you want to hold the money?">
          <h1 className="invite-title">Money you can hold.</h1>
          <p className="invite-line">
            Turn on your camera and the note jumps into your hand. Pinch it, throw it, crumple it, shine a UV torch from your fingertip — and rub your
            fingers together to print more.
          </p>
          <div className="invite-actions">
            <button className="btn btn-primary" onClick={useHands} autoFocus>
              <span className="led" /> Use my hands
            </button>
            <button className="btn" onClick={useMouse}>
              Use the {coarse ? 'touchscreen' : 'mouse'}
            </button>
          </div>
          <p className="invite-fine mono">The camera stays on this page. Nothing is recorded or sent.</p>
        </section>
      )}

      {hud.tracking === 'loading' && <div className="status mono">{hud.loadingMsg}</div>}
      {camera && hud.tracking === 'on' && hud.hands === 0 && <div className="hint mono">Raise an open hand to the camera</div>}

      {!intro && (
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
          </label>

          <ol className="legend" aria-label="Gestures">
            {legend.map((g) => (
              <li key={g.name} className={`gesture ${active.has(g.pose) ? 'is-active' : ''}`}>
                <span className="gesture-icon">{g.icon}</span>
                <span className="gesture-text">
                  <span className="gesture-name">{g.name}</span>
                  <span className="gesture-does mono">{g.does}</span>
                </span>
              </li>
            ))}
          </ol>

          <div className="actions">
            {coarse && !camera && (
              <>
                <HoldButton label="Print" onHold={(on) => engineRef.current?.setPrinting(on)} />
                <HoldButton label="UV" onHold={(on) => engineRef.current?.setTorch(on)} />
              </>
            )}
            <button
              className={`icon-btn ${hud.tracking === 'on' ? 'is-on' : ''}`}
              onClick={toggleCamera}
              title={hud.tracking === 'on' ? 'Turn the camera off' : 'Use your hands (camera)'}
            >
              <IconCamera />
              <span className="mono">{hud.tracking === 'on' ? (hud.hands ? `${hud.hands} hand${hud.hands > 1 ? 's' : ''}` : 'No hands') : 'Hands'}</span>
            </button>
            <button className="icon-btn" onClick={save} title="Save this moment (PNG)">
              <IconSave />
              <span className="mono">Keep</span>
            </button>
            <button className="icon-btn" onClick={toggleSound} title={soundOn ? 'Mute' : 'Sound on'} aria-pressed={soundOn}>
              {soundOn ? <IconSound /> : <IconMute />}
            </button>
          </div>
        </footer>
      )}

      {toast && (
        <div className="toast mono" key={toast} role="status">
          {toast}
        </div>
      )}
      {failed && (
        <div className="fallback">
          <p>This toy needs WebGL2, which this browser doesn&rsquo;t offer. Try a recent Chrome, Safari or Firefox.</p>
        </div>
      )}
    </div>
  );
}

function HoldButton({ label, onHold }: { label: string; onHold: (on: boolean) => void }) {
  return (
    <button
      className="icon-btn hold-btn"
      onPointerDown={(e) => {
        e.preventDefault();
        sound.wake();
        onHold(true);
      }}
      onPointerUp={() => onHold(false)}
      onPointerLeave={() => onHold(false)}
      onPointerCancel={() => onHold(false)}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className="mono">{label}</span>
    </button>
  );
}

// ------------------------------------------------------------------ icons
// Line drawings of hands, kept as simple as the gestures themselves.

const icon = {
  width: 22,
  height: 22,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function IconOpen() {
  return (
    <svg {...icon}>
      <path d="M7 13 V6.5 a1.2 1.2 0 0 1 2.4 0 V11 M9.4 11 V4.8 a1.2 1.2 0 0 1 2.4 0 V11 M11.8 11 V5.6 a1.2 1.2 0 0 1 2.4 0 V11.5 M14.2 11.5 V7.6 a1.2 1.2 0 0 1 2.4 0 V14 c0 4 -2.4 6.5 -5.6 6.5 c-2.6 0 -3.9 -1.2 -5.2 -3.4 L4.2 13.6 a1.3 1.3 0 0 1 2.2 -1.3 L7 13" />
    </svg>
  );
}

function IconPinch() {
  return (
    <svg {...icon}>
      <path d="M8 20 c-2.4 -2 -3.4 -4.4 -2.6 -7.2 L8.6 8.4 a1.4 1.4 0 0 1 2.4 1.4 L10 12" />
      <path d="M10 12 L14.6 5.2 a1.4 1.4 0 0 1 2.4 1.5 L13.4 12.2" />
      <path d="M13.4 12.2 c2 0.6 3.4 2 3.4 4.2 c0 2.2 -1.4 3.6 -3.4 3.6" />
      <circle cx="15.9" cy="5.9" r="2.6" opacity="0.5" />
    </svg>
  );
}

function IconFist() {
  return (
    <svg {...icon}>
      <path d="M6.5 10 a2 2 0 0 1 2 -2 h7 a2.5 2.5 0 0 1 2.5 2.5 v3.5 c0 3.6 -2.6 6 -6 6 h-1 c-2.6 0 -4.5 -2 -4.5 -4.5 Z" />
      <path d="M8.5 8 v3 M11 8 v3 M13.5 8 v3 M16 8.3 v2.7" />
      <path d="M6.5 12.5 h4.5 a1.5 1.5 0 0 1 0 3 h-2" />
    </svg>
  );
}

function IconPoint() {
  return (
    <svg {...icon}>
      <path d="M10 13 V4.4 a1.3 1.3 0 0 1 2.6 0 V12 M12.6 11 h1.6 a1.4 1.4 0 0 1 1.4 1.4 v0.4 M15.6 12.6 a1.3 1.3 0 0 1 2.6 0.4 v2.2 c0 3.2 -2.4 5.3 -5.4 5.3 c-2.4 0 -3.8 -1 -5 -3 L6.2 14.6 a1.3 1.3 0 0 1 2.1 -1.4 L10 15" />
      <path d="M8 3 l-1.4 -1.2 M14.6 3 l1.4 -1.2 M11.3 1 v-0.4" opacity="0.7" />
    </svg>
  );
}

function IconRub() {
  return (
    <svg {...icon}>
      <path d="M6 20 c-1.6 -2 -2 -4.4 -1 -7 L8 7.6 a1.3 1.3 0 0 1 2.3 1.2 L9 12" />
      <path d="M9 12 L12.6 4.4 a1.3 1.3 0 0 1 2.4 1 L12.8 10.6 M12.8 10.6 L15.6 6 a1.3 1.3 0 0 1 2.3 1.2 L15 12.4" />
      <path d="M15 12.4 c1.6 1 2.2 2.6 1.8 4.4 c-0.5 2.2 -2.6 3.4 -5 3.2" />
      <path d="M18.8 2.6 c1 0.8 1.6 1.9 1.6 3.2 M20.6 1 c1.4 1.2 2.2 2.8 2.2 4.6" opacity="0.7" />
    </svg>
  );
}

function IconCamera() {
  return (
    <svg {...icon} width={18} height={18}>
      <path d="M4 8 h3 l2 -2.5 h6 l2 2.5 h3 v11 H4 Z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

function IconSave() {
  return (
    <svg {...icon} width={18} height={18}>
      <path d="M12 4 v11 M7.5 10.5 L12 15 l4.5 -4.5" />
      <path d="M5 19 h14" />
    </svg>
  );
}

function IconSound() {
  return (
    <svg {...icon} width={18} height={18}>
      <path d="M5 10 h3 l4 -4 v12 l-4 -4 H5 Z" />
      <path d="M15.5 9.5 a3.5 3.5 0 0 1 0 5 M18 7 a7 7 0 0 1 0 10" />
    </svg>
  );
}

function IconMute() {
  return (
    <svg {...icon} width={18} height={18}>
      <path d="M5 10 h3 l4 -4 v12 l-4 -4 H5 Z" />
      <path d="M16 10 l4 4 M20 10 l-4 4" />
    </svg>
  );
}
