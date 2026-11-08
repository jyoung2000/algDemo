import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Glyph } from '@now-playing/aqua-ui/icons';
import type { TasteSummary } from './api';
import { classNames } from './util';
import { SNAPSHOT_MAX, describeSound, generalLabel, gradientStops, pushSnapshot, soundChanges, soundView, type Change, type Snapshot, type SoundView } from './taste-view';
import { GenreTicker } from './GenreTicker';
import { TasteHistory } from './TasteHistory';
import './mobile-refinement.css';

const STORE_KEY = 'airwave.sound.history';

function loadHistory(key: string): Snapshot[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]') as Snapshot[];
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
export function SoundCard({
  taste,
  listening,
  defaultOpen = false,
  title = 'Your sound',
  label = 'Your listening mix',
  historyKey = STORE_KEY,
  emptyText,
  idleText = 'Play, skip or like songs and this redraws.',
}: {
  taste: TasteSummary | null;
  listening: boolean;
  defaultOpen?: boolean;
  /** PLAYLIST-MIX-001: the same card draws a saved list's sound, under its own title and history. */
  title?: string;
  label?: string;
  historyKey?: string;
  emptyText?: string;
  idleText?: string;
}) {
  const view = useMemo(() => soundView(taste), [taste]);
  const [open, setOpen] = useState(defaultOpen);
  const [history, setHistory] = useState<Snapshot[]>(() => loadHistory(historyKey));
  const bodyId = `sound-body-${historyKey.replace(/[^a-z0-9]+/gi, '-')}`;
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
          localStorage.setItem(historyKey, JSON.stringify(next));
        } catch {
          /* storage full or blocked: the ribbon just stays for this session */
        }
      }
      return next;
    });
  }, [view, historyKey]);

  // The pulse is a short class, not a remount, so the segments keep their elements and their widths animate.
  useEffect(() => {
    if (!pulse) return;
    const t = window.setTimeout(() => setPulse(false), 1000);
    return () => window.clearTimeout(t);
  }, [pulse]);

  const summary = describeSound(view);
  const announce = changes.length ? `${title} updated: ${changes.map((c) => `${c.label} ${c.dir === 'new' ? 'is new' : c.dir}`).join(', ')}.` : '';

  return (
    <section className={classNames('sound', open && 'is-open', listening && 'is-live')} aria-label={title}>
      <button className="sound__head" type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
        <span className="sound__title">
          <span className={classNames('sound__live', listening && 'is-on')} aria-hidden="true" />
          {title}
        </span>
        <span className="sound__summary-label">{label}</span>
        <span className="sound__chev" aria-hidden="true">
          <Glyph name={open ? 'chevron-up' : 'chevron-down'} size={14} />
        </span>
      </button>

      <GenreTicker entries={view?.leaves ?? []} />
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
          idleText
        ) : (
          emptyText ?? 'Finish or skip a few songs and your sound appears here.'
        )}
      </p>

      {open && (
        <div id={bodyId} className="sound__body">
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
                      {f.broadPct > 0 && <li className="schip schip--broad"><span className="schip__dot" style={{ background: f.color }} aria-hidden="true" />{generalLabel(f.name)} <b>{f.broadPct}%</b></li>}
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

          <TasteHistory history={history} />
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


