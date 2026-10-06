import { useEffect, useRef, useState } from 'react';
import { BordersEngine, type BordersHud } from './borders/engine';
import { COUNTRIES, countryByCode, formatMoney } from './borders/countries';
import { sound } from './sound';

const params = new URLSearchParams(location.search);
const countryIndex = countryByCode(params.get('c'));
const coarse = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
const narrow = typeof window !== 'undefined' && window.innerWidth < 640;

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<BordersEngine | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [hud, setHud] = useState<BordersHud | null>(null);
  const [soundOn, setSoundOn] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [tilt, setTilt] = useState(false);
  const toastTimer = useRef(0);
  const country = COUNTRIES[countryIndex];

  const flash = (msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3600);
  };

  useEffect(() => {
    const canvas = canvasRef.current!;
    let engine: BordersEngine;
    try {
      engine = new BordersEngine(canvas, countryIndex);
    } catch (e) {
      console.error(e);
      setFailed(true);
      return;
    }
    engineRef.current = engine;
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
  }, [country.name]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'p' || e.key === 'P') engineRef.current?.print(3);
      if (e.key === 'o' || e.key === 'O') openBorder();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const openBorder = () => {
    const w = engineRef.current?.openBorder();
    if (!w) flash('Allow pop-ups for this page to open a border.');
  };

  const enableTilt = async () => {
    sound.wake();
    const DOE = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    try {
      if (DOE?.requestPermission && (await DOE.requestPermission()) !== 'granted') return;
    } catch {
      return;
    }
    const onTilt = (e: DeviceOrientationEvent) => {
      const g = ((e.gamma ?? 0) * Math.PI) / 180; // left/right
      const b = ((e.beta ?? 90) * Math.PI) / 180; // front/back
      engineRef.current?.setTilt({ x: Math.sin(g), y: Math.max(0.15, Math.sin(b)) });
    };
    window.addEventListener('deviceorientation', onTilt);
    setTilt(true);
    flash('Tilt the phone. The money slides.');
  };

  const toggleSound = () => {
    const next = !soundOn;
    sound.wake();
    sound.setEnabled(next);
    setSoundOn(next);
  };

  const pointer = (kind: 'down' | 'move' | 'up') => (e: React.PointerEvent) => {
    if (kind === 'down') (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    engineRef.current?.pointer(kind, e.pointerId, e.clientX, e.clientY);
  };

  // the window's own title bar and tab icon join in: balance and currency
  useEffect(() => {
    const n = hud?.notesHere ?? 0;
    document.title = `${formatMoney(country, n)} · ${country.name}`;
  }, [hud?.notesHere, country]);

  useEffect(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    g.fillStyle = '#0b0b0a';
    g.beginPath();
    g.roundRect(0, 0, 64, 64, 14);
    g.fill();
    g.fillStyle = '#c6fe1f';
    g.font = `600 ${country.symbol.length > 1 ? 26 : 40}px Georgia, "Times New Roman", serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(country.symbol, 32, 35);
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.type = 'image/png';
    link.href = c.toDataURL('image/png');
  }, [country]);

  const here = hud?.notesHere ?? 0;
  const alone = (hud?.open.length ?? 1) <= 1;
  const reserves = formatMoney(country, here);

  return (
    <div className={`app ${ready ? 'is-ready' : ''} ${alone ? 'is-alone' : ''}`}>
      <canvas
        ref={canvasRef}
        className="stage"
        onPointerDown={pointer('down')}
        onPointerMove={pointer('move')}
        onPointerUp={pointer('up')}
        onPointerCancel={pointer('up')}
        onContextMenu={(e) => e.preventDefault()}
        role="img"
        aria-label={`${country.name}: banknotes of the Dodo Reserve, printed in ${country.currency}. Drag and throw them; throw one hard at the edge to send it to another window.`}
      />

      <header className="masthead">
        <div className="wordmark">{country.name}</div>
        <div className="sub mono">
          {country.currency} · 1 DODO = {formatMoney(country, 1)}
        </div>
      </header>

      <section className="supply mono" aria-live="polite">
        <div className="supply-row">
          <span className="supply-label">Held here</span>
          <span className="supply-value">{reserves}</span>
        </div>
        <ol className="countries" aria-label="Countries open on this desktop">
          {(hud?.open ?? [{ country: countryIndex, self: true }]).map((o, i) => (
            <li key={`${o.country}-${i}`} className={o.self ? 'is-self' : ''} title={COUNTRIES[o.country].name}>
              {COUNTRIES[o.country].code}
            </li>
          ))}
        </ol>
      </section>

      <footer className="dock">
        <p className="hint-line">
          {alone
            ? narrow || coarse
              ? 'Drag a note and throw it. On a laptop, open a second country and send money across the desktop.'
              : 'Every window is a country. Open a border, then throw a note hard at the edge.'
            : 'Throw hard at an edge to clear customs. Overlap two windows and the border opens.'}
        </p>
        <div className="actions">
          {!(narrow || coarse) && (
            <button className="btn btn-primary" onClick={openBorder}>
              <span className="led" /> Open a border
            </button>
          )}
          {(narrow || coarse) && !tilt && (
            <button className="btn btn-primary" onClick={enableTilt}>
              <span className="led" /> Tilt to move money
            </button>
          )}
          <button className="btn" onClick={() => engineRef.current?.print(3)} title="Print three more notes (P)">
            Print money
          </button>
          <button className="icon-btn" onClick={toggleSound} title={soundOn ? 'Mute' : 'Sound on'} aria-pressed={soundOn}>
            {soundOn ? <IconSound /> : <IconMute />}
          </button>
        </div>
      </footer>

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

const icon = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

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
