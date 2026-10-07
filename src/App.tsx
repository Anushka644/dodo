import { useEffect, useRef, useState } from 'react';
import { IslandEngine, WIND_HEAD, type IslandHud, type Milestone } from './island/engine';
import { PALETTES, PATTERNS } from './island/palettes';
import { makePlate, roman } from './island/plate';
import { PaperMirror } from './island/face/mirror';
import { sound } from './sound';

const HINTS = [
  'Press and hold on the sea to raise land.',
  'Now hold R, or the rain button, and let it rain. Forests follow the rain.',
  'Drag across the sky to move the sun.',
  'Shift-drag to carve. Right-drag to turn the island. Click a dodo to say hello.',
];

// the naturalist's log: one line for each first
const LOG: Record<Milestone, string> = {
  fire: 'Fire under the water. The sea boils.',
  land: 'Land, where there was only sea.',
  rain: 'The first rain.',
  green: 'Green on the slopes.',
  river: 'A river finds its way down to the sea.',
  egg: 'An egg — and then a chick.',
  birds: 'Seabirds have come to nest.',
  night: 'The first night. The surf glows.',
  lavaSea: 'Lava meets the sea, in a roar of steam.',
  lake: 'A hollow fills and becomes a lake.',
  half: 'Forest over half the island.',
  safe: 'Twelve dodos. Enough to stay.',
  face: 'A face in the sky, watching.',
  sunshine: 'A smile, and the sun came out.',
  storm: 'A frown, and the sky broke.',
  sleep: 'Eyes closed, and the night came down.',
  wind: 'A face blew from the corner of the sky, as on the old charts.',
  roar: 'A roar, and the mountain answered.',
};

// while your face is the weather, the hints teach it one expression at a time
const FACE_STEPS: [Milestone, string][] = [
  ['sunshine', 'Smile.'],
  ['storm', 'Now frown.'],
  ['sleep', 'Close your eyes for a moment.'],
  ['wind', 'Puff out your cheeks and blow.'],
  ['roar', 'Open wide, and roar.'],
];

function faceHint(hud: IslandHud, tried: Set<Milestone>, status: string): string {
  if (hud.face === 'starting') return status || 'Waking the camera…';
  if (hud.face === 'looking') return 'Look at the camera.';
  const next = FACE_STEPS.find(([m]) => !tried.has(m));
  return next ? next[1] : 'Move your head: the island sits behind the glass.';
}

// the legend under the mirror: each expression and what it does to the island
const LEGEND: [keyof IslandHud['expr'], string, string][] = [
  ['smile', 'Smile', 'sun'],
  ['frown', 'Frown', 'rain'],
  ['closed', 'Close your eyes', 'night'],
  ['blow', 'Puff and blow', 'wind'],
  ['roar', 'Open wide', 'eruption'],
];

interface Entry {
  id: number;
  stamp: string;
  text: string;
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<IslandEngine | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [hud, setHud] = useState<IslandHud | null>(null);
  const [soundOn, setSoundOn] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [hint, setHint] = useState(0);
  const [log, setLog] = useState<Entry[]>([{ id: 0, stamp: 'D1 06:40', text: 'The last dodo, alone on a rock.' }]);
  const [ending, setEnding] = useState(false);
  const [tried, setTried] = useState<Set<Milestone>>(new Set());
  const [faceBusy, setFaceBusy] = useState(false);
  // the wind head stays up a moment after you stop blowing, so it never bounces
  const [windShown, setWindShown] = useState(false);
  const [windHead, setWindHead] = useState({ x: 0, y: 0, r: 84 });
  const [faceStatus, setFaceStatus] = useState('');
  const faceBusyRef = useRef(false);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const mirror = useRef<PaperMirror | null>(null);
  const plates = useRef(0);
  const logId = useRef(1);
  const toastTimer = useRef(0);

  const flash = (msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3400);
  };

  useEffect(() => {
    const canvas = canvasRef.current!;
    let engine: IslandEngine;
    try {
      engine = new IslandEngine(canvas);
    } catch (e) {
      console.error(e);
      setFailed(true);
      return;
    }
    engineRef.current = engine;
    engine.onHud = setHud;
    engine.onHatch = (n) => flash(n === 2 ? 'An egg hatched. The last dodo is not the last any more.' : `Another dodo hatched. ${n} on the island.`);
    engine.onMilestone = (m, day, hour) => {
      const id = logId.current++;
      setLog((l) => [...l, { id, stamp: `D${day} ${hour}`, text: LOG[m] }].slice(-4));
      setTried((t) => new Set(t).add(m));
      if (m === 'safe') {
        setEnding(true);
        window.setTimeout(() => setEnding(false), 9000);
      }
    };
    engine.run();
    setReady(true);
    document.body.dataset.ready = '1';
    const onResize = () => engine.layout();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      mirror.current?.dispose();
      engine.dispose();
    };
  }, []);

  // the hints move along as you do each thing
  useEffect(() => {
    if (!hud) return;
    if (hint === 0 && hud.land > 0.6) setHint(1);
    if (hint === 1 && hud.forest > 0.3) setHint(2);
    if (hint === 2 && hud.mode === 'sun') setHint(3);
  }, [hud, hint]);

  // hold R for rain
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.key === 'r' || e.key === 'R') && !e.repeat && !e.metaKey && !e.ctrlKey) engineRef.current?.setRain(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'r' || e.key === 'R') engineRef.current?.setRain(false);
    };
    const blur = () => engineRef.current?.setRain(false);
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
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const engine = engineRef.current;
      if (!engine) return;
      const n = Number(e.key);
      if (n >= 1 && n <= PALETTES.length) engine.palette = n - 1;
      else if (e.key === 'p' || e.key === 'P') engine.pattern = (engine.pattern + 1) % PATTERNS.length;
      else if (e.key === '[') engine.setPx(engine.px - 1);
      else if (e.key === ']') engine.setPx(engine.px + 1);
      else if (e.key === 'ArrowLeft') engine.orbit(-0.15, 0);
      else if (e.key === 'ArrowRight') engine.orbit(0.15, 0);
      else if (e.key === 'ArrowUp') engine.orbit(0, 0.08);
      else if (e.key === 'ArrowDown') engine.orbit(0, -0.08);
      else if (e.key === 'h' || e.key === 'H') engine.home();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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

  // two fingers on a touchscreen: turn and zoom
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; x: number; y: number } | null>(null);

  const onDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.current.size === 2) {
      engineRef.current?.pointerUp();
      const [a, b] = [...touches.current.values()];
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      return;
    }
    engineRef.current?.pointerDown(e.clientX, e.clientY, e.button, e.shiftKey);
  };

  const onMove = (e: React.PointerEvent) => {
    if (touches.current.has(e.pointerId)) touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.current.size === 2 && pinch.current) {
      const [a, b] = [...touches.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const x = (a.x + b.x) / 2;
      const y = (a.y + b.y) / 2;
      engineRef.current?.wheel((pinch.current.d - d) * 4);
      engineRef.current?.orbit(-(x - pinch.current.x) * 0.006, (y - pinch.current.y) * 0.004);
      pinch.current = { d, x, y };
      return;
    }
    engineRef.current?.pointerMove(e.clientX, e.clientY, e.shiftKey);
  };

  const onUp = (e: React.PointerEvent) => {
    touches.current.delete(e.pointerId);
    if (touches.current.size < 2) pinch.current = null;
    engineRef.current?.pointerUp();
  };

  // a print, mounted as a plate with its caption
  const save = async () => {
    const engine = engineRef.current;
    if (!engine || !hud) return;
    const n = ++plates.current;
    const blob = await makePlate(engine.snapshot(), {
      number: n,
      day: hud.day,
      hour: hud.hour,
      dodos: hud.dodos,
      land,
      forest,
      ...engine.plateInks(),
    });
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `raphus-plate-${n}.png`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    flash(`Plate ${roman(n)} printed.`);
  };

  const toggleSound = () => {
    const next = !soundOn;
    sound.wake();
    sound.setEnabled(next);
    setSoundOn(next);
  };

  // lend your face: the camera, the tracker, and the mirror printed by Paper Shaders
  const toggleFace = async () => {
    const engine = engineRef.current;
    if (!engine) return;
    sound.wake();
    // while it's starting, the button cancels
    if (faceBusyRef.current || engine.faceActive) {
      mirror.current?.dispose();
      mirror.current = null;
      engine.disableFace();
      faceBusyRef.current = false;
      setFaceBusy(false);
      setFaceStatus('');
      return;
    }
    faceBusyRef.current = true;
    setFaceBusy(true);
    try {
      const video = await engine.enableFace(setFaceStatus);
      // the mirror is a nicety: if it can't start, the face still works
      try {
        const { ink, paper } = engine.mirrorInks();
        if (mirrorRef.current) mirror.current = await PaperMirror.create(mirrorRef.current, video, ink, paper);
      } catch (err) {
        console.warn('[mirror]', err);
      }
    } catch (e) {
      const name = e instanceof DOMException ? e.name : '';
      if (name !== 'AbortError') {
        console.warn('[face]', e);
        engine.disableFace();
        flash(
          !window.isSecureContext || !navigator.mediaDevices
            ? 'The camera needs a secure (https) page.'
            : name === 'NotAllowedError' || name === 'SecurityError'
              ? 'The camera stayed closed. Allow it from the address bar to lend your face.'
              : name === 'NotFoundError' || name === 'OverconstrainedError'
                ? 'No camera here. The island works without it.'
                : name === 'NotReadableError'
                  ? 'Another app is using the camera.'
                  : 'Face tracking couldn’t load. The island works without it.',
        );
      }
    } finally {
      faceBusyRef.current = false;
      setFaceBusy(false);
      setFaceStatus('');
    }
  };

  // a hidden tab gives the camera back; and a camera that goes away by itself says so
  useEffect(() => {
    let away = false;
    const onVis = () => {
      const e = engineRef.current;
      if (!e) return;
      if (document.visibilityState === 'hidden') {
        if (!e.faceActive || faceBusyRef.current) return;
        mirror.current?.dispose();
        mirror.current = null;
        e.disableFace();
        away = true;
      } else if (away) {
        away = false;
        flash('The camera closed while you were away. Lend your face again?');
      }
    };
    document.addEventListener('visibilitychange', onVis);
    const e = engineRef.current;
    if (e) {
      e.onFaceLost = () => {
        mirror.current?.dispose();
        mirror.current = null;
        flash('The camera went away. Lend your face again when it’s back.');
      };
    }
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [ready]);

  const blowing = !!hud?.expr.blow;
  useEffect(() => {
    if (blowing) {
      setWindShown(true);
      return;
    }
    const id = window.setTimeout(() => setWindShown(false), 400);
    return () => window.clearTimeout(id);
  }, [blowing]);

  // where the wind head sits: a corner of the sky, clear of the masthead, smaller on a phone;
  // the shader is told too, so the breath streams from its mouth
  useEffect(() => {
    const place = () => {
      const r = window.innerWidth <= 640 ? 56 : 84;
      const top = document.querySelector('.masthead')?.getBoundingClientRect().bottom ?? 96;
      const x = Math.max(r + 12, window.innerWidth * WIND_HEAD.x);
      const y = Math.max(top + r + 10, window.innerHeight * WIND_HEAD.y);
      setWindHead({ x, y, r });
      if (engineRef.current) engineRef.current.windHeadAt = { x, y };
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [ready]);

  // the mirror prints in the island's inks as the day turns
  useEffect(() => {
    if (!mirror.current || !engineRef.current) return;
    const id = window.setInterval(() => {
      const e = engineRef.current;
      if (e && mirror.current) {
        const { ink, paper } = e.mirrorInks();
        mirror.current.setInks(ink, paper);
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [hud?.face]);

  const engine = engineRef.current;
  const faceOn = !!hud && hud.face !== 'off';
  const windy = faceOn && windShown;
  const land = hud ? (hud.land * 0.8).toFixed(1) : '0.0';
  const forest = hud && hud.land > 0.05 ? Math.min(100, Math.round((hud.forest / hud.land) * 100)) : 0;

  return (
    <div className={`app ${ready ? 'is-ready' : ''} mode-${hud?.mode ?? 'idle'} ${windy ? `is-windy wind-${hud?.windSide}` : ''}`}>
      <canvas
        ref={canvasRef}
        className="stage"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={() => engineRef.current?.pointerLeave()}
        onDoubleClick={(e) => engineRef.current?.focus(e.clientX, e.clientY)}
        onContextMenu={(e) => e.preventDefault()}
        role="img"
        aria-label="A dithered island in the sea. Press and hold to raise land; drag the sky to move the sun."
      />

      <header className="masthead">
        <div className="wordmark">Raphus</div>
        <div className="sub mono">an island for the last dodo</div>
      </header>

      <section className="readout mono" aria-live="polite">
        <div className="clock">
          <span className="day">Day {hud?.day ?? 1}</span>
          {hud?.hour ?? '06:40'}
        </div>
        <div className="stats">
          <span>
            {hud?.dodos ?? 1} dodo{(hud?.dodos ?? 1) === 1 ? '' : 's'}
          </span>
          <span className="dot">·</span>
          <span>{land} km² of land</span>
          <span className="dot">·</span>
          <span>{forest}% forest</span>
        </div>
      </section>

      {hud && hud.intro < 1 ? (
        <div className="title" style={{ opacity: Math.min(1, hud.intro * 4) * Math.min(1, (1 - hud.intro) * 5) }}>
          <div className="title-place mono">Mauritius · 1662</div>
          <div className="title-line">The last dodo has nowhere left to go.</div>
          <div className="title-sub">Make it an island.</div>
        </div>
      ) : ending ? (
        <div className="title ending" role="status">
          <div className="title-place mono">Raphus cucullatus</div>
          <div className="title-line">Not extinct.</div>
          <div className="title-note">Last seen in 1662. Still here, on the island you made.</div>
        </div>
      ) : faceOn && hud ? (
        <p className="hint" key={`face-${faceHint(hud, tried, faceStatus)}`}>
          {faceHint(hud, tried, faceStatus)}
        </p>
      ) : (
        <p className="hint" key={hint}>
          {HINTS[hint]}
        </p>
      )}

      <figure
        className={`mirror ${faceOn ? 'is-on' : ''} ${windy ? `is-wind ${hud?.windSide}` : ''}`}
        aria-hidden={!faceOn}
        style={{ '--wx': `${windHead.x}px`, '--wy': `${windHead.y}px`, '--wr': `${windHead.r}px` } as React.CSSProperties}
      >
        <div className="mirror-print" ref={mirrorRef} />
        <figcaption className="mono">You, printed by Paper Shaders</figcaption>
        <ul className="legend mono" aria-label="What your face does">
          {LEGEND.map(([k, face, does]) => (
            <li key={k} className={hud?.expr[k] ? 'is-on' : ''}>
              <span>{face}</span>
              <span className="does">{does}</span>
            </li>
          ))}
        </ul>
      </figure>

      <ol className="log" aria-label="Log">
        {log.map((e, i) => (
          <li key={e.id} style={{ opacity: 0.35 + 0.65 * ((i + 1) / log.length) }}>
            <span className="stamp mono">{e.stamp}</span>
            <span className="entry">{e.text}</span>
          </li>
        ))}
      </ol>

      <footer className="dock">
        <div className="group" role="radiogroup" aria-label="Inks">
          {PALETTES.map((p, i) => (
            <button
              key={p.name}
              className={`swatch ${hud?.palette === i ? 'is-on' : ''}`}
              onClick={() => engine && (engine.palette = i)}
              title={`${p.name} (${i + 1})`}
              role="radio"
              aria-checked={hud?.palette === i}
            >
              {i === 0 ? (
                <span className="sw sw-day" />
              ) : (
                <span className="sw" style={{ background: `linear-gradient(90deg, ${css(p.inks[0])} 0 50%, ${css(p.inks[3])} 50% 100%)` }} />
              )}
              <span className="label mono">{p.name}</span>
            </button>
          ))}
        </div>

        <div className="actions">
          <button
            className={`rain mono ${hud?.raining ? 'is-on' : ''}`}
            onPointerDown={(e) => {
              e.preventDefault();
              engineRef.current?.setRain(true);
            }}
            onPointerUp={() => engineRef.current?.setRain(false)}
            onPointerLeave={() => engineRef.current?.setRain(false)}
            onPointerCancel={() => engineRef.current?.setRain(false)}
            onContextMenu={(e) => e.preventDefault()}
            title="Hold to make it rain (R)"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
              <path d="M7 15a4 4 0 0 1-.6-7.95A5.5 5.5 0 0 1 17 8.5a3.5 3.5 0 0 1 .5 6.5" />
              <path d="M9 18l-1 3M13 17l-1 3M17 18l-1 3" />
            </svg>
            Hold for rain
          </button>

          <button className={`facebtn mono ${faceOn ? 'is-on' : ''}`} onClick={toggleFace} aria-pressed={faceOn} title="Your face becomes the island's weather (uses the camera)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="12" cy="12" r="8.5" />
              <path d="M8.5 14.5c1 1.4 2.2 2 3.5 2s2.5-.6 3.5-2" />
              <path d="M9 9.5h.01M15 9.5h.01" />
            </svg>
            {faceBusy ? 'Cancel' : faceOn ? 'Take back your face' : 'Lend your face'}
          </button>
        </div>

        <div className="group">
          <button className="chip mono" onClick={() => engine && (engine.pattern = (engine.pattern + 1) % PATTERNS.length)} title="Dither pattern (P)">
            {PATTERNS[hud?.pattern ?? 0]}
          </button>
          <div className="stepper mono" title="Dot size ([ and ])">
            <button onClick={() => engine?.setPx(engine.px - 1)} aria-label="Smaller dots">
              −
            </button>
            <span>{hud?.px ?? 2}px</span>
            <button onClick={() => engine?.setPx(engine.px + 1)} aria-label="Bigger dots">
              +
            </button>
          </div>
          <button className="chip mono" onClick={save} title="Save a print">
            Print
          </button>
          <button className="chip mono" onClick={toggleSound} aria-pressed={soundOn} title={soundOn ? 'Mute' : 'Sound on'}>
            {soundOn ? 'Sound' : 'Muted'}
          </button>
        </div>
      </footer>

      {toast && (
        <div className="toast" key={toast} role="status">
          {toast}
        </div>
      )}
      {failed && (
        <div className="fallback">
          <p>This island needs WebGL2, which this browser doesn&rsquo;t offer. Try a recent Chrome, Safari or Firefox.</p>
        </div>
      )}
    </div>
  );
}

function css(rgb: [number, number, number]) {
  return `rgb(${rgb.map((c) => Math.round(c * 255)).join(',')})`;
}
