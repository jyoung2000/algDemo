import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { CATALOG } from './engine/taste-catalog';
import {
  BAND,
  BPM_MAX,
  BPM_MIN,
  MAP_FAMILIES,
  familyName,
  MAP_SUBS,
  bottomPct,
  familyAt,
  fitsAt,
  leftPct,
  pointFor,
  subAt,
  type MapSub,
} from './taste-map';

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

  const sub: MapSub = useMemo(() => subAt(hue, bpm), [hue, bpm]);
  const fam = familyAt(hue);
  const fit = useMemo(() => new Set(fitsAt(fam, bpm)), [fam, bpm]);
  const famSubs = MAP_SUBS.filter((s) => s.family === fam);
  const felt = sub.halftime ? ` (felt as ${Math.round(sub.lo / 2)}–${Math.round(sub.hi / 2)})` : '';

  const setFrom = (clientX: number, clientY: number) => {
    const r = field.current?.getBoundingClientRect();
    if (!r) return;
    setHue(Math.min(359.9, Math.max(0, ((clientX - r.left) / r.width) * 360)));
    setBpm(Math.round(BPM_MIN + Math.min(1, Math.max(0, 1 - (clientY - r.top) / r.height)) * (BPM_MAX - BPM_MIN)));
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
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
    setHue((h) => Math.min(359.9, Math.max(0, h + d[0])));
    setBpm((b) => Math.min(BPM_MAX, Math.max(BPM_MIN, b + d[1])));
  };
  const jump = (s: MapSub) => {
    const p = pointFor(s);
    setHue(p.hue);
    setBpm(Math.round(p.bpm));
  };

  return (
    <div className="tpick">
      <div className="tpick__head">
        <div className="tpick__title">{sub.name}</div>
        <div className="tpick__readout">
          {familyName(fam)} · {bpm} BPM · {sub.years}
        </div>
      </div>

      <div className="tpick__axes">
        <span>Genre →</span>
        <span>{BPM_MAX} BPM</span>
      </div>
      <div
        ref={field}
        className="tpick__field"
        role="img"
        tabIndex={0}
        aria-label={`Taste field. Left to right is the genre spectrum; bottom to top is ${BPM_MIN} to ${BPM_MAX} BPM. Drag, tap, or use the arrow keys.`}
        aria-valuetext={`${sub.name}, ${familyName(fam)}, ${bpm} BPM`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onKeyDown={onKey}
        style={{ ['--tp-h' as string]: BAND }}
      >
        {trail && trail.length > 1 && (
          <svg className="tpick__trail" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <polyline
              points={trail.map((p) => `${leftPct(p.hue)},${100 - bottomPct(p.bpm)}`).join(' ')}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )}
        {trail?.map((p, i) => (
          <span
            key={`trail-${i}`}
            className={i === trail.length - 1 ? 'tpick__step tpick__step--now' : 'tpick__step'}
            title={`${i + 1}. ${p.label}`}
            style={{ left: `${leftPct(p.hue)}%`, bottom: `${bottomPct(p.bpm)}%` }}
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
            style={{ left: `${leftPct(p.hue)}%`, bottom: `${bottomPct(p.bpm)}%`, background: `hsl(${p.hue} 90% 62%)` }}
          />
        ))}
        <span className="tpick__dot" style={{ left: `${leftPct(hue)}%`, bottom: `${bottomPct(bpm)}%`, background: `hsl(${hue} 90% 66%)` }} />
      </div>
      <div className="tpick__axes">
        <span />
        <span>{BPM_MIN} BPM</span>
      </div>
      <div className="tpick__fams" aria-hidden="true">
        {MAP_FAMILIES.map((f, i) => (
          <span key={f.name} aria-current={i === fam}>
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
            {Math.max(sub.lo, bpm - 4)}–{Math.min(sub.hi, bpm + 4)} BPM{felt} · {sub.name} runs {sub.lo}–{sub.hi}
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
            data-fit={fit.has(MAP_SUBS.filter((x) => x.family === fam).indexOf(s)) ? 1 : 0}
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
