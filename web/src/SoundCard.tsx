import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Glyph } from '@now-playing/aqua-ui/icons';
import type { TasteSummary } from './api';
import { classNames } from './util';
import { SNAPSHOT_MAX, describeSound, gradientStops, pushSnapshot, snapshotColor, soundChanges, soundView, familyLabel, type Change, type Snapshot, type SoundView } from './taste-view';

const STORE_KEY = 'airwave.sound.history';
const pct = (x: number) => `${Math.round(x * 100)}%`;

function loadHistory(): Snapshot[] {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]') as Snapshot[];
    return Array.isArray(v) ? v.filter((s) => s && Array.isArray(s.segs)).slice(-SNAPSHOT_MAX) : [];
  } catch {
    return [];
  }
}

/**
 * "Your sound": the learned taste as a gradient of the genre families you keep, the subgenres inside
 * each, what you skip, and a ribbon of how it has moved. It redraws every time the engine learns from a
 * song, so the user watches the algorithm change while they listen. UX rules: color is always paired
 * with a name and a percent; motion is a width transition only (the global reduced-motion rule stops it).
 */
export function SoundCard({ taste, listening, defaultOpen = false }: { taste: TasteSummary | null; listening: boolean; defaultOpen?: boolean }) {
  const view = useMemo(() => soundView(taste), [taste]);
  const [open, setOpen] = useState(defaultOpen);
  const [history, setHistory] = useState<Snapshot[]>(loadHistory);
  const [changes, setChanges] = useState<Change[]>([]);
  const [pulse, setPulse] = useState(false);
  const prev = useRef<SoundView | null>(null);

  useEffect(() => {
    if (!view) return;
    const ch = soundChanges(prev.current, view);
    if (prev.current && prev.current.events !== view.events) {
      setChanges(ch);
      setPulse(true);
    }
    prev.current = view;
    setHistory((h) => {
      const next = pushSnapshot(h, view, Date.now());
      if (next !== h) {
        try {
          localStorage.setItem(STORE_KEY, JSON.stringify(next));
        } catch {
          /* storage full or blocked: the ribbon just stays for this session */
        }
      }
      return next;
    });
  }, [view]);

  // The pulse is a short class, not a remount, so the segments keep their elements and their widths animate.
  useEffect(() => {
    if (!pulse) return;
    const t = window.setTimeout(() => setPulse(false), 1000);
    return () => window.clearTimeout(t);
  }, [pulse]);

  const summary = describeSound(view);
  const announce = changes.length ? `Your sound updated: ${changes.map((c) => `${c.label} ${c.dir === 'new' ? 'is new' : c.dir}`).join(', ')}.` : '';

  return (
    <section className={classNames('sound', open && 'is-open', listening && 'is-live')} aria-label="Your sound">
      <button className="sound__head" type="button" aria-expanded={open} aria-controls="sound-body" onClick={() => setOpen((o) => !o)}>
        <span className="sound__title">
          <span className={classNames('sound__live', listening && 'is-on')} aria-hidden="true" />
          Your sound
        </span>
        <span className="sound__sum">{summary}</span>
        <span className="sound__chev" aria-hidden="true">
          <Glyph name={open ? 'chevron-up' : 'chevron-down'} size={14} />
        </span>
      </button>

      <div className={classNames('sound__bar', pulse && 'is-pulse')} role="img" aria-label={summary}>
        {view && view.families.length ? (
          <span className="sound__grad" style={barVars(view)} title={describeSound(view, 8)} />
        ) : (
          <span className="sound__grad sound__grad--empty" />
        )}
      </div>

      <p className="sound__changes" role="status" aria-live="polite">
        {announce ? (
          <>
            {changes.map((c) => (
              <span key={c.label} className={classNames('sound__chg', `sound__chg--${c.dir}`)}>
                <span aria-hidden="true">{c.dir === 'down' ? '▾' : c.dir === 'up' ? '▴' : '＋'}</span> {c.label}
              </span>
            ))}
          </>
        ) : view ? (
          'Play, skip or like songs and this redraws.'
        ) : (
          'Finish or skip a few songs and your sound appears here.'
        )}
      </p>

      {open && (
        <div id="sound-body" className="sound__body">
          {view && view.families.length > 0 ? (
            <ul className="sound__fams">
              {view.families.map((f) => (
                <li key={f.slug} className="sfam">
                  <div className="sfam__row">
                    <span className="sfam__dot" style={{ background: f.color }} aria-hidden="true" />
                    <span className="sfam__name">{f.name}</span>
                    <span className="sfam__pct">{f.pct}%</span>
                  </div>
                  <div className="sfam__track" aria-hidden="true">
                    <span className="sfam__fill" style={{ width: `${f.pct}%`, background: f.color }} />
                  </div>
                  {(f.subs.length > 0 || f.broadPct > 0) && (
                    <ul className="sfam__subs">
                      {f.subs.map((s) => (
                        <li key={s.key} className="schip" title={`${s.label}: ${s.plays} kept`}>
                          <span className="schip__dot" style={{ background: s.color }} aria-hidden="true" />
                          {s.label} <b>{s.pct}%</b>
                        </li>
                      ))}
                      {f.broadPct > 0 && <li className="schip schip--broad">General {f.name.toLowerCase()} <b>{f.broadPct}%</b></li>}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="sound__empty">Nothing kept yet. Songs you finish, replay or like pull your sound toward them.</p>
          )}

          {view && (view.avoided.length > 0 || view.bpm) && (
            <div className="sound__facts">
              {view.bpm ? <span className="sfact">Tempo you stay near <b>{view.bpm} BPM</b></span> : null}
              {view.avoided.length > 0 && (
                <span className="sfact sfact--skip">
                  You skip <b>{view.avoided.map((a) => a.label).join(', ')}</b>
                </span>
              )}
            </div>
          )}

          {history.length > 1 && (
            <div className="sound__hist">
              <p className="sound__histh">How it has moved <span>last {history.length} updates, oldest left</span></p>
              <ol className="ribbon" aria-label="Your sound over time, oldest first">
                {history.map((s) => (
                  <li key={s.t + ':' + s.events} className="ribbon__col" title={s.segs.slice(0, 4).map((g) => `${g.label ?? familyLabel(g.slug)} ${pct(g.share)}`).join(', ')}>
                    <span className="ribbon__stack" style={{ background: gradientOfSnap(s) }} />
                  </li>
                ))}
              </ol>
            </div>
          )}
          {view && view.unplaced.length > 0 && <p className="sound__note">Also liked, outside the eight families: {view.unplaced.slice(0, 4).join(', ')}.</p>}
          <p className="sound__note">Learned from {view?.events ?? 0} {view?.events === 1 ? 'song' : 'songs'} you played. Recent listening counts most; it halves every two weeks.</p>
        </div>
      )}
    </section>
  );
}

/** CSS custom properties for the bar: stop colours and positions, so a change animates the gradient itself. */
function barVars(view: SoundView): CSSProperties {
  const st = gradientStops(view.bar);
  const v: Record<string, string> = {};
  for (let i = 0; i < 8; i++) {
    const x = st[Math.min(i, st.length - 1)]!;
    v[`--c${i}`] = x.color;
    v[`--p${i}`] = i < st.length ? `${x.at.toFixed(1)}%` : '100%';
  }
  return v as CSSProperties;
}

/** One column of the history: that update's breakdown as hard-edged bands, top to bottom, so each share is readable. */
function gradientOfSnap(s: Snapshot): string {
  const total = s.segs.reduce((a, g) => a + g.share, 0) || 1;
  let at = 0;
  const stops = s.segs.map((g) => {
    const from = at;
    at += (g.share / total) * 100;
    return `${g.color ?? snapshotColor(g.slug)} ${from.toFixed(1)}% ${at.toFixed(1)}%`;
  });
  return stops.length ? `linear-gradient(180deg, ${stops.join(', ')})` : 'transparent';
}
