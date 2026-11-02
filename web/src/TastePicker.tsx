import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { CATALOG } from './engine/taste-catalog';
import {
  BAND,
  BPM_MAX,
  BPM_MIN,
  MAP_FAMILIES,
  familyName,
  MAP_SUBS,
  familyAt,
  fitsAt,
  pointFor,
  subAt,
  type MapSub,
} from './taste-map';

import { AUTO_FIT_DELAY, AUTO_FIT_DURATION, FULL_VIEW, fitTaste, pointAt, projectPoint, revealPoint, selectionInView, tweenView, validPoint, viewportBackground, zoomTaste, type TasteViewport } from './taste-viewport';
import './taste-picker-zoom.css';

const pct = (x: number) => `${Math.round(x)}%`;

/** Interactive field: drag, tap or arrow keys. Colour band = family, height = tempo. */
// The strip under the field is decorative (aria-hidden), so it uses short labels that fit eight columns at phone width.
const SHORT: Record<string, string> = { 'Soul/Jazz/Funk': 'Soul', Electronic: 'Electro', 'Ambient/Chill': 'Chill', 'R&B/Afro/Latin': 'R&B' };

/** One played song on the map: its position, and its label (number 1 is the oldest of the trail). */
export interface TrailPoint {
  hue: number;
  bpm: number;
  label: string;
  /** Album cover shown in the step marker; the number badge stays for order. */
  art?: string | null;
  /** Song title, written under the marker on hover and in the tooltip. */
  title?: string;
}

export function TastePicker({ placed, trail }: { placed?: { hue: number; bpm: number; label: string }[]; trail?: TrailPoint[] }) {
  const [hue, setHue] = useState(246);
  const [bpm, setBpm] = useState(126);
  const field = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<TasteViewport>(FULL_VIEW);
  const currentView = useRef(view);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);
  const manual = useRef(false);
  const autoStarted = useRef(false);
  const points = [...(placed ?? []), ...(trail ?? [])].filter(validPoint);
  const pointsKey = JSON.stringify(points.map(p => [p.hue, p.bpm]));
  const latestPoints = useRef(points);
  latestPoints.current = points;
  const updateView = (v: TasteViewport) => { currentView.current = v; setView(v); };
  const stopMotion = () => {
    clearTimeout(timer.current);
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
  };
  const cancelAuto = () => { manual.current = true; stopMotion(); };
  const select = (p: { hue: number; bpm: number }) => { setHue(p.hue); setBpm(p.bpm); };
  const fit = () => {
    cancelAuto();
    const target = fitTaste(latestPoints.current);
    select(selectionInView(target, { hue, bpm }));
    updateView(target);
  };
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onPreference = () => { if (media.matches) cancelAuto(); };
    media.addEventListener('change', onPreference);
    if (!media.matches && !manual.current && !autoStarted.current && latestPoints.current.length) {
      timer.current = setTimeout(() => {
        autoStarted.current = true;
        const target = fitTaste(latestPoints.current);
        select(selectionInView(target, { hue, bpm }));
        const from = currentView.current;
        const start = performance.now();
        const tick = (now: number) => {
          if (manual.current || media.matches) return;
          const progress = (now - start) / AUTO_FIT_DURATION;
          updateView(tweenView(from, target, progress));
          if (progress < 1) frame.current = requestAnimationFrame(tick);
        };
        frame.current = requestAnimationFrame(tick);
      }, AUTO_FIT_DELAY);
    }
    return () => { stopMotion(); media.removeEventListener('change', onPreference); };
  }, [pointsKey]);
  const pos = (h: number, b: number) => {
    const p = projectPoint(view, { hue: h, bpm: b });
    return { left: `${p.left}%`, bottom: `${p.bottom}%` };
  };
  const zoom = (delta: number) => {
    cancelAuto();
    updateView(zoomTaste(currentView.current, 1 / currentView.current.size + delta, { hue, bpm }));
  };

  const sub: MapSub = useMemo(() => subAt(hue, bpm), [hue, bpm]);
  const fam = familyAt(hue);
  const fittingSubs = useMemo(() => new Set(fitsAt(fam, bpm)), [fam, bpm]);
  const famSubs = MAP_SUBS.filter((s) => s.family === fam);
  const felt = sub.halftime ? ` (felt as ${Math.round(sub.lo / 2)}–${Math.round(sub.hi / 2)})` : '';

  const setFrom = (clientX: number, clientY: number) => {
    const r = field.current?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return;
    const p = pointAt(currentView.current, (clientX - r.left) / r.width, 1 - (clientY - r.top) / r.height);
    select({ hue: Math.min(359.9, p.hue), bpm: p.bpm });
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.isPrimary === false) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setFrom(e.clientX, e.clientY);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) setFrom(e.clientX, e.clientY);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step: Record<string, [number, number]> = {
      ArrowLeft: [-BAND / 10, 0],
      ArrowRight: [BAND / 10, 0],
      ArrowUp: [0, 4],
      ArrowDown: [0, -4],
    };
    const d = step[e.key];
    if (!d) return;
    e.preventDefault();
    const p = { hue: Math.min(359.9, Math.max(0, hue + d[0])), bpm: Math.min(BPM_MAX, Math.max(BPM_MIN, bpm + d[1])) };
    select(p);
    updateView(revealPoint(currentView.current, p));
  };
  const jump = (s: MapSub) => {
    const p = pointFor(s);
    cancelAuto();
    select(p);
    updateView(revealPoint(currentView.current, p));
  };

  return (
    <div className="tpick" onPointerDownCapture={cancelAuto} onKeyDownCapture={cancelAuto} onWheelCapture={cancelAuto}>
      <div className="tpick__head">
        <div className="tpick__title">{sub.name}</div>
        <div className="tpick__readout">
          {familyName(fam)} · {Math.round(bpm)} BPM · {sub.years}
        </div>
      </div>

      <div className="tpick__zoom" role="group" aria-label="Taste maker zoom controls">
        <button type="button" aria-label="Zoom out" disabled={view.size >= 1} onClick={() => zoom(-.5)}>−</button>
        <span className="tpick__zoom-level" aria-label="Map zoom">{(1 / view.size).toFixed(1)}×</span>
        <button type="button" aria-label="Zoom in" disabled={view.size <= .25} onClick={() => zoom(.5)}>+</button>
        <button type="button" onClick={() => { cancelAuto(); updateView(FULL_VIEW); }}>Show all</button>
        <button type="button" disabled={!points.length} onClick={fit}>My taste</button>
      </div>
      <div className="tpick__axes">
        <span>Genre → · {Math.round(view.x * 360)}–{Math.round((view.x + view.size) * 360)}°</span>
        <span>{Math.round(pointAt(view, 0, 1).bpm)} BPM</span>
      </div>
      <div
        ref={field}
        className="tpick__field"
        role="img"
        tabIndex={0}
        aria-label={`Taste maker field. Visible genre spectrum ${Math.round(view.x * 360)} to ${Math.round((view.x + view.size) * 360)} degrees; bottom to top is ${Math.round(pointAt(view, 0, 0).bpm)} to ${Math.round(pointAt(view, 0, 1).bpm)} BPM. Selected ${sub.name}, ${Math.round(bpm)} BPM. Drag, tap, or use the arrow keys.`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onKeyDown={onKey}
        style={{ ['--tp-h' as string]: BAND, ...viewportBackground(view) }}
      >
        {trail && trail.length > 1 && (
          <svg className="tpick__trail" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <polyline
              points={trail.map((p) => `${projectPoint(view, p).left},${100 - projectPoint(view, p).bottom}`).join(' ')}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )}
        {trail?.map((p, i) => (
          <span
            key={`trail-${i}`}
            className={i === trail.length - 1 ? 'tpick__step tpick__step--now' : 'tpick__step'}
            title={`${i + 1}. ${p.label}`}
            style={{ ...pos(p.hue, p.bpm) }}
          >
            {p.art ? <img src={p.art} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" /> : null}
            <i aria-hidden="true">{i + 1}</i>
          </span>
        ))}
        {placed?.map((p, i) => (
          <span
            key={i}
            className="tpick__placed"
            title={p.label}
            style={{ ...pos(p.hue, p.bpm), background: `hsl(${p.hue} 90% 62%)` }}
          />
        ))}
        <span className="tpick__dot" style={{ ...pos(hue, bpm), background: `hsl(${hue} 90% 66%)` }} />
      </div>
      <div className="tpick__axes">
        <span />
        <span>{Math.round(pointAt(view, 0, 0).bpm)} BPM</span>
      </div>
      <div className="tpick__fams" aria-hidden="true">
        {MAP_FAMILIES.map((f, i) => (
          <span key={f.name} aria-current={i === fam} style={{
            left: `${Math.max(0, (i / 8 - view.x) / view.size) * 100}%`,
            width: `${Math.max(0, Math.min(1, ((i + 1) / 8 - view.x) / view.size) - Math.max(0, (i / 8 - view.x) / view.size)) * 100}%`,
          }}>
            {SHORT[f.name] ?? f.name}
          </span>
        ))}
      </div>

      <section className="tpick__card" aria-live="polite">
        <h3>What {sub.name} sounds like</h3>
        <p className="tpick__sound">{sub.sound}</p>
        <dl className="tpick__kv">
          <dt>Tempo</dt>
          <dd>
            {Math.round(Math.max(sub.lo, bpm - 4))}–{Math.round(Math.min(sub.hi, bpm + 4))} BPM{felt} · {sub.name} runs {sub.lo}–{sub.hi}
          </dd>
          <dt>Era</dt>
          <dd>{sub.years}</dd>
          <dt>Energy</dt>
          <dd>
            <span className="tpick__meter">
              <i style={{ width: pct(sub.energy * 100) }} />
            </span>
          </dd>
          <dt>Brightness</dt>
          <dd>
            <span className="tpick__meter">
              <i style={{ width: pct(sub.brightness * 100) }} />
            </span>
          </dd>
          <dt>Artists</dt>
          <dd>{sub.artists.join(', ')}</dd>
        </dl>
      </section>

      <div className="tpick__row">
        <h4>In {familyName(fam)}</h4>
        <span className="tpick__hint">Lit = fits this tempo</span>
      </div>
      <div className="tpick__chips">
        {famSubs.map((s, i) => (
          <button
            key={s.key}
            type="button"
            className="tpick__chip"
            data-fit={fittingSubs.has(MAP_SUBS.filter((x) => x.family === fam).indexOf(s)) ? 1 : 0}
            aria-pressed={s.key === sub.key}
            onClick={() => jump(s)}
          >
            {s.name} <span className="tpick__hint">{s.lo}–{s.hi}</span>
          </button>
        ))}
      </div>

      <div className="tpick__row">
        <h4>Every genre and subgenre</h4>
        <span className="tpick__hint">Tap any to jump there</span>
      </div>
      <div className="tpick__catalog">
        {CATALOG.map((f, fi) => (
          <section key={f.name} className="tpick__fam" style={{ ['--fh' as string]: fi * BAND + BAND / 2 }}>
            <header>
              <i />
              <b>{f.name}</b>
              <span>
                {Math.min(...f.subs.map((s) => s.lo))}–{Math.max(...f.subs.map((s) => s.hi))} BPM
              </span>
            </header>
            <p>{f.sound}</p>
            <div className="tpick__chips">
              {f.subs.map((s) => (
                <button
                  key={s.name}
                  type="button"
                  className="tpick__chip"
                  title={s.sound}
                  onClick={() => jump(MAP_SUBS.find((x) => x.name === s.name)!)}
                >
                  {s.name} <span className="tpick__hint">{s.lo}–{s.hi}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
