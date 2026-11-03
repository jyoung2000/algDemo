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

import { AUTO_FIT_DELAY, AUTO_FIT_DURATION, FULL_VIEW, WHEEL_STEP, fitTaste, panTaste, pointAt, projectPoint, revealPoint, selectionInView, tweenView, validPoint, viewportBackground, zoomAt, zoomTaste, type TasteViewport } from './taste-viewport';
import { spreadMarkers } from './taste-spread';
import { genreInk, genreSwatch } from './genre-color';
import './taste-picker-zoom.css';

const pct = (x: number) => `${Math.round(x)}%`;
/** Cover-art marker at 1x zoom. The ringed current song is a third larger. */
const MARKER_BASE_PX = 42;
/**
 * A marker stands for a fixed point on the field, so it scales with the zoom: zoom in and the
 * art grows while the points move apart; zoom out and it shrinks. Bounded so it stays readable
 * at the smallest view and never swallows the field at the largest. The owner, at 4x: the ten
 * tiles formed the same cross as at 1x, because they were a fixed 42px and a pixel-space spreader
 * fanned ten plays of one song around one point — zoom changed nothing.
 */
const markerPx = (zoom: number, fieldWidth = 0) =>
  // The cap knows the field it is in: 96px is right on an 830px desktop field and, with the ringed
  // current song a third larger, 35% of a 362px phone field — it dominated the map. One fifth of
  // the width keeps the ringed marker under about 30% anywhere.
  Math.min(fieldWidth > 0 ? Math.min(96, fieldWidth * 0.2) : 96, Math.max(28, MARKER_BASE_PX * zoom));
/** The widest marker (the ringed current song) at 1x, used by the viewport fit. */
const MARKER_PX = Math.round(MARKER_BASE_PX * 4 / 3);

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

/**
 * @param focus Where the cursor should start: the listener's strongest kept genre.
 *
 * TASTE-ACCURACY-001: this used to open at a hardcoded (246, 126) — the Electronic band — so the
 * reading under the field named a genre picked by nothing but that constant. A hip-hop listener
 * opened their own Profile and was told "Selected Garage / psych rock", or dance and EDM pop.
 * Starting on their strongest genre means the first thing the field says about them is true.
 */
export function TastePicker({ placed, trail, focus }: { placed?: { hue: number; bpm: number; label: string }[]; trail?: TrailPoint[]; focus?: { hue: number; bpm: number } | null }) {
  const [hue, setHue] = useState(focus?.hue ?? 246);
  const [bpm, setBpm] = useState(focus?.bpm ?? 126);
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
    // Keep the listener's own genre under the cursor when it is inside the fitted view.
    select(selectionInView(target, focus ?? { hue, bpm }));
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
        select(selectionInView(target, focus ?? { hue, bpm }));
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
  // The cover art must not cover other cover art, and two plays of one song land on the same
  // point, so collisions are resolved in screen space. That needs the field's real size, because
  // a marker's footprint as a PERCENTAGE of the field differs on each axis and at each width.
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const trailKey = JSON.stringify((trail ?? []).map((p) => [p.hue, p.bpm]));
  const trailPos = useMemo(() => {
    const t = trail ?? [];
    const raw = t.map((p) => projectPoint(view, p));
    if (!box.w || !box.h) return raw;
    // Newest first, so the ringed current song keeps its true position and older plays give way.
    const px = markerPx(1 / view.size, box.w) * 4 / 3;
    const spread = spreadMarkers([...raw].reverse(), { w: (px / box.w) * 100, h: (px / box.h) * 100 });
    return spread.reverse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trailKey, view.x, view.y, view.size, box.w, box.h]);
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
  /**
   * Mouse-1 drags the map; a click still picks a genre.
   *
   * Touch keeps its existing behaviour, where a drag picks: a finger has no hover, so dragging to
   * read the map is how the field is explored on a phone, and that is the behaviour already
   * verified on the device. Only a mouse gets pan, which is what the owner asked for.
   */
  const drag = useRef<{ id: number; x: number; y: number; panning: boolean } | null>(null);
  /** A mouse moves a few pixels during an ordinary click; beyond this it is a drag. */
  const PAN_THRESHOLD_PX = 4;
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.isPrimary === false) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (e.pointerType === 'mouse') {
      // Defer: this is only a selection if the mouse does not travel.
      drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, panning: false };
      cancelAuto();
      return;
    }
    setFrom(e.clientX, e.clientY);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const d = drag.current;
    if (e.pointerType === 'mouse') {
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.panning && Math.hypot(dx, dy) < PAN_THRESHOLD_PX) return;
      d.panning = true;
      const r = e.currentTarget.getBoundingClientRect();
      if (!r.width || !r.height) return;
      // y is measured upward on the map but downward on the screen.
      updateView(panTaste(currentView.current, dx / r.width, -dy / r.height));
      d.x = e.clientX;
      d.y = e.clientY;
      return;
    }
    setFrom(e.clientX, e.clientY);
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (e.pointerType !== 'mouse' || !d || d.id !== e.pointerId) return;
    // A press that never became a drag is a click, and a click picks a genre.
    if (!d.panning) setFrom(e.clientX, e.clientY);
  };
  // The wheel zooms about the cursor. It has to be a NATIVE listener registered with
  // { passive: false }: React attaches wheel at the root as passive, so preventDefault() on a
  // synthetic event is ignored and the page scrolls away underneath the zoom.
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    const onWheel = (e: globalThis.WheelEvent) => {
      if (!e.deltaY) return;
      e.preventDefault();
      cancelAuto();
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const v = currentView.current;
      const next = 1 / v.size + (e.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP);
      updateView(zoomAt(v, next, (e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
        {/* The colour IS the genre on this map, so the name carries it: a dot in the map's own
            fill, and the name in a readable version of the same hue (see genre-color.ts for why
            the fill itself cannot be used as text). */}
        <div className="tpick__title" style={{ color: genreInk(hue) }}>
          <span className="tpick__swatch" aria-hidden="true" style={{ background: genreSwatch(hue) }} />
          {sub.name}
        </div>
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
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={onKey}
        style={{ ['--tp-h' as string]: BAND, ['--tp-marker' as string]: `${markerPx(1 / view.size, box.w)}px`, ...viewportBackground(view) }}
      >
        {trail?.map((p, i) => (
          <span
            key={`trail-${i}`}
            className={i === trail.length - 1 ? 'tpick__step tpick__step--now' : 'tpick__step'}
            title={`${i + 1}. ${p.label}`}
            style={{ left: `${(trailPos[i] ?? projectPoint(view, p)).left}%`, bottom: `${(trailPos[i] ?? projectPoint(view, p)).bottom}%` }}
          >
            {p.art ? <img src={p.art} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" /> : null}
            <i aria-hidden="true">{i + 1}</i>
          </span>
        ))}
        {/* The field plots cover art only. The listener's genres are NOT drawn as dots: with
            nothing on the field to name them they read as random marks. They still drive the
            viewport fit through `points`, so the field is framed on the listener's taste. */}
        <span className="tpick__dot" style={{ ...pos(hue, bpm), background: `hsl(${hue} 90% 66%)` }} />
      </div>
      <div className="tpick__axes">
        <span />
        <span>{Math.round(pointAt(view, 0, 0).bpm)} BPM</span>
      </div>
      <div className="tpick__fams" aria-hidden="true">
        {MAP_FAMILIES.map((f, i) => {
          const left = Math.max(0, (i / 8 - view.x) / view.size);
          const right = Math.min(1, (i + 1) / 8 - view.x >= 0 ? ((i + 1) / 8 - view.x) / view.size : 0);
          const shown = Math.max(0, right - left);
          // A family at the edge of the view keeps only a sliver of its band, too narrow for its name:
          // showing "In…" reads as a bug, so a band narrower than half its full width says nothing.
          const whole = 1 / 8 / view.size;
          return (
            <span
              key={f.name}
              aria-current={i === fam}
              style={{ left: `${left * 100}%`, width: `${shown * 100}%`, visibility: shown < whole * 0.55 ? 'hidden' : undefined }}
            >
              {SHORT[f.name] ?? f.name}
            </span>
          );
        })}
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
