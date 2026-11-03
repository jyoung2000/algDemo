import { useState, type CSSProperties } from 'react';
import { Glyph, ProviderMark } from '@now-playing/aqua-ui/icons';
import type { FeedbackKind, PlaylistSummary, RecItem, Track } from './api';
import { Art } from './Art';
import { SaveMenu } from './SaveMenu';
import { PROVIDER_LABEL, TIER_LABEL, artistOf, classNames, describeCharacteristics, fmtDuration, fmtRelease, genreTags, markKey, pickerColorFor, playbackOfTrack, toneLabel } from './util';

export interface FeedbackFlags {
  like?: boolean;
  dislike?: boolean;
  hide?: boolean;
  save?: boolean;
}

interface Props {
  /** Starting songs: the first rows of the same list, removable and emphasisable. */
  seeds: Track[];
  onRemoveSeed: (key: string) => void;
  onEmphasis: (key: string, emphasis: number) => void;
  items: RecItem[];
  focusKey: string | null;
  playingKey: string | null;
  flags: Record<string, FeedbackFlags>;
  onFocus: (key: string) => void;
  onPlay: (item: RecItem) => void;
  /** Play a starting song (preview or provider player), used by the seed rows. */
  onPlayTrack: (track: Track) => void;
  onFeedback: (item: RecItem, kind: FeedbackKind) => void;
  onDownload?: (track: Track) => void;
  /** The listener's saved lists, for the menu that opens when a song is liked. */
  lists?: PlaylistSummary[];
  onLists?: (lists: PlaylistSummary[]) => void;
}

/**
 * One list: starting songs first, then the discovery queue. Order of the queue is the server's
 * diversified order; nothing here re-sorts it.
 * Arrow keys / j k move between rows; Enter plays; the row keeps focus when results refresh.
 */
export function Results({ seeds, onRemoveSeed, onEmphasis, items, focusKey, playingKey, flags, onFocus, onPlay, onPlayTrack, onFeedback, onDownload, lists, onLists }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  /** Which row's save menu is showing, by song key. Only one opens at a time. */
  const [saving, setSaving] = useState<string | null>(null);

  const move = (from: number, dir: 1 | -1) => {
    const next = items[from + dir];
    if (!next) return;
    onFocus(next.track.key);
    document.getElementById(rowId(next.track.key))?.focus();
  };

  return (
    <ol className="recs" aria-label="Your songs and discovery queue">
      {seeds.map((s) => {
        const strong = (s.emphasis ?? 1) > 1;
        const pb = playbackOfTrack(s);
        const seedPlayable = Boolean(pb.preview || pb.embed);
        return (
          <li key={`seed:${s.key}`} className={classNames('rec', 'rec--seed', strong && 'is-strong', playingKey === s.key && 'is-playing')}>
            <span className="rec__rank" aria-hidden="true">
              {playingKey === s.key ? <Glyph name="speaker" size={12} /> : <Glyph name="star" size={12} />}
            </span>
            <button
              className="rec__art"
              type="button"
              onClick={() => (seedPlayable ? onPlayTrack(s) : undefined)}
              disabled={!seedPlayable}
              aria-label={seedPlayable ? `Play ${s.title}` : `${s.title} has no player here`}
              tabIndex={-1}
            >
              <Art src={s.artwork} size={56} />
              {seedPlayable && (
                <span className="rec__playover" aria-hidden="true">
                  <Glyph name="play" size={16} />
                </span>
              )}
            </button>
            <div className="rec__text">
              <span className="rec__title" title={s.title}>
                {s.title}
              </span>
              <span className="rec__artist">{artistOf(s)}</span>
            </div>
            <div className="rec__sub">
              <span className="rec__why1">Starting song{strong ? ' · counts double' : ''}</span>
            </div>
            <span className="rec__tier" />
            <span className="rec__dur" />
            <div className="rec__actions">
              {seedPlayable && (
                <button className="iconbtn" type="button" onClick={() => onPlayTrack(s)} aria-label={`Play ${s.title}`} title="Play">
                  <Glyph name="play" size={14} />
                </button>
              )}
              <button
                className={classNames('iconbtn', strong && 'is-on')}
                type="button"
                aria-pressed={strong}
                title={strong ? 'Emphasised: counts double' : 'Emphasise this song'}
                aria-label={strong ? `Stop emphasising ${s.title}` : `Emphasise ${s.title}`}
                onClick={() => onEmphasis(s.key, strong ? 1 : 2)}
              >
                <Glyph name="star" size={14} />
              </button>
              {onDownload && (
                <button className="iconbtn" type="button" onClick={() => onDownload(s)} aria-label={`Download ${s.title}`} title="Download">
                  <Glyph name="download" size={14} />
                </button>
              )}
              <button className="iconbtn" type="button" aria-label={`Remove ${s.title}`} title="Remove" onClick={() => onRemoveSeed(s.key)}>
                <Glyph name="close" size={14} />
              </button>
            </div>
          </li>
        );
      })}
      {items.map((it, i) => {
        const t = it.track;
        const f = flags[t.key] ?? {};
        const playable = Boolean(it.playback.preview || it.playback.embed);
        const isOpen = open === t.key;
        const facts = describeCharacteristics(it.characteristics);
        // One coloured bubble per genre or subgenre, no separators. The Taste Picker colour sits on the family/subgenre bubble.
        const genreBubbles = genreTags(it.characteristics);
        const toneFact = toneLabel(it.characteristics);
        const toneColor = it.characteristics?.color ?? null;
        return (
          <li
            key={t.key}
            id={rowId(t.key)}
            className={classNames('rec', focusKey === t.key && 'is-focus', playingKey === t.key && 'is-playing', f.dislike && 'is-disliked')}
            tabIndex={focusKey === t.key || (focusKey == null && i === 0) ? 0 : -1}
            aria-current={playingKey === t.key ? 'true' : undefined}
            onFocus={(e) => {
              if (e.target === e.currentTarget) onFocus(t.key);
            }}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === 'ArrowDown' || e.key === 'j') {
                e.preventDefault();
                move(i, 1);
              } else if (e.key === 'ArrowUp' || e.key === 'k') {
                e.preventDefault();
                move(i, -1);
              } else if (e.key === 'Enter' && playable) {
                e.preventDefault();
                onPlay(it);
              }
            }}
          >
            <span className="rec__rank" aria-hidden="true">
              {playingKey === t.key ? <Glyph name="speaker" size={12} /> : it.rank}
            </span>
            <button className="rec__art" type="button" onClick={() => (playable ? onPlay(it) : undefined)} disabled={!playable} aria-label={playable ? `Play ${t.title}` : `${t.title} has no player here`} tabIndex={-1}>
              <Art src={t.artwork} size={56} />
              {playable && (
                <span className="rec__playover" aria-hidden="true">
                  <Glyph name="play" size={16} />
                </span>
              )}
            </button>
            <div className="rec__text">
              <span className="rec__title" title={t.title}>
                {t.title}
                {(t.versions ?? (t.version ? [t.version] : [])).map((v) => (
                  <span key={v} className="vtag">
                    {v}
                  </span>
                ))}
                {it.new_release && <span className="vtag vtag--new">New</span>}
              </span>
              <span className="rec__artist">{artistOf(t)}</span>
            </div>
            <div className="rec__sub">
              <span className="rec__why1">{it.reasons[0]?.text ?? 'Found from your starting songs.'}</span>
              {(genreBubbles.length > 0 || facts.length > 0) && (
                <span className="rec__facts" aria-label="Song details">
                  {genreBubbles.map((g) => {
                    const tone = pickerColorFor(g) ?? toneColor;
                    return (
                      <span key={g} className="genre" style={tone ? ({ '--tone': tone } as CSSProperties) : undefined}>
                        {g}
                      </span>
                    );
                  })}
                  {facts.map((f) => (
                    <span key={f} className="fact">
                      {f}
                    </span>
                  ))}
                </span>
              )}
            </div>
            <span className="rec__tier" title={`Evidence: ${it.evidence}`}>
              {TIER_LABEL[it.tier]}
            </span>
            <span className="rec__dur">{fmtDuration(t.duration)}</span>
            <div className="rec__actions">
              {playable && (
                <button className="iconbtn" type="button" onClick={() => onPlay(it)} aria-label={`Play ${t.title}`} title="Play">
                  <Glyph name="play" size={14} />
                </button>
              )}
              <button
                className={classNames('iconbtn', f.like && 'is-on')}
                type="button"
                aria-pressed={Boolean(f.like)}
                aria-expanded={onLists ? saving === t.key : undefined}
                onClick={() => {
                  // Liking opens the save menu so the song can go straight into chosen lists.
                  // Unliking is immediate: there is nothing to choose.
                  if (f.like) {
                    onFeedback(it, 'unlike');
                    setSaving(null);
                    return;
                  }
                  onFeedback(it, 'like');
                  if (onLists) setSaving(t.key);
                }}
                aria-label={f.like ? `Remove like from ${t.title}` : `Like ${t.title} and choose lists`}
                title={f.like ? 'Liked' : 'Like'}
              >
                <Glyph name="thumb-up" size={14} />
              </button>
              <button
                className={classNames('iconbtn', f.dislike && 'is-bad')}
                type="button"
                aria-pressed={Boolean(f.dislike)}
                onClick={() => onFeedback(it, f.dislike ? 'undislike' : 'dislike')}
                aria-label={f.dislike ? `Undo dislike of ${t.title}` : `Dislike ${t.title}`}
                title={f.dislike ? 'Disliked' : 'Not for me'}
              >
                <Glyph name="thumb-down" size={14} />
              </button>
              {onDownload && (
                <button className="iconbtn" type="button" onClick={() => onDownload(t)} aria-label={`Download ${t.title}`} title="Download">
                  <Glyph name="download" size={14} />
                </button>
              )}
              <button className="iconbtn" type="button" onClick={() => onFeedback(it, 'hide')} aria-label={`Hide ${t.title}`} title="Hide">
                <Glyph name="close" size={14} />
              </button>
              <button
                className={classNames('linkbtn', 'whybtn')}
                type="button"
                aria-expanded={isOpen}
                aria-controls={`why-${rowId(t.key)}`}
                aria-label={`Why ${t.title}?`}
                title="Why this song?"
                onClick={() => setOpen(isOpen ? null : t.key)}
              >
                {/* A phone has no room for the full phrase beside five icons; the name stays whole for AT. */}
                <span className="whybtn__full">Why this song?</span>
                <span className="whybtn__short" aria-hidden="true">
                  Why?
                </span>
              </button>
            </div>
            {saving === t.key && onLists && (
              <div className="rec__savemenu">
                <SaveMenu songKey={t.key} title={t.title} lists={lists ?? []} onLists={onLists} onClose={() => setSaving(null)} />
              </div>
            )}
            {isOpen && <Why item={it} id={`why-${rowId(t.key)}`} />}
          </li>
        );
      })}
    </ol>
  );
}

function Why({ item, id }: { item: RecItem; id: string }) {
  const t = item.track;
  return (
    <div className="why" id={id}>
      <ul className="why__reasons">
        {item.reasons.map((r) => (
          <li key={r.factor + r.text}>{r.text}</li>
        ))}
      </ul>
      {item.best_seed && (
        <p className="why__line">
          Closest to your starting song <b>{item.best_seed.title}</b> — {item.best_seed.artist}.
        </p>
      )}
      {item.uncertainty.length > 0 && (
        <ul className="why__unsure">
          {item.uncertainty.map((u) => (
            <li key={u}>
              <Glyph name="info" size={11} /> {u}
            </li>
          ))}
        </ul>
      )}
      <p className="why__meta">
        Evidence {item.evidence} · found via {item.sources.join(', ') || 'provider search'}
        {t.release ? ` · ${fmtRelease(t.release)} (${t.release.source})` : ''}
      </p>
      <p className="why__open">
        {item.playback.open.map((o) => (
          <a key={o.provider} className="openlink" href={o.url} target="_blank" rel="noreferrer noopener">
            <ProviderMark provider={markKey(o.provider)} size={13} /> {o.label}
          </a>
        ))}
        {!item.playback.open.length && t.url && (
          <a className="openlink" href={t.url} target="_blank" rel="noreferrer noopener">
            <ProviderMark provider={markKey(t.provider)} size={13} /> Open in {PROVIDER_LABEL[t.provider] ?? t.provider}
          </a>
        )}
      </p>
    </div>
  );
}

export function rowId(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return `rec-${(h >>> 0).toString(36)}`;
}
