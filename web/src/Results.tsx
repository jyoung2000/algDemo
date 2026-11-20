import { useState, type CSSProperties } from 'react';
import { Glyph, type GlyphName } from '@now-playing/aqua-ui/icons';
import { SimilarGlyph } from './icons';
import { Marquee } from './Marquee';
import { TagStrip } from './TagStrip';
import { ROW_COVER } from './row-cover';
import './song-row.css';
import type { ArtistTarget, Characteristics, FeedbackKind, PlaylistSummary, RecItem, Track } from './api';
import type { CacheState, CardCache } from './engine/queue-controls';
import { RowPlayButton, playOnDoubleClick } from './RowPlay';
import { Art } from './Art';
import { matchRecordings } from './engine/identity';
import { SaveMenu } from './SaveMenu';
import { SongStar, inPlaylist } from './SongStar';
import { SongCredits } from './SongCredits';
import { SwipeLi } from './useSwipeRemove';
import { PROVIDER_LABEL, TIER_LABEL, bubbleNote, canPlayHere, classNames, describeCharacteristics, fmtDuration, fmtRelease, playbackOfTrack, toneLabel, type GenreBubble } from './util';
import { songTagBubbles } from './engine/display-tags';
import { ConfirmRemove, confirmRemoveWanted } from './ConfirmRemove';

/**
 * One genre bubble (TAGS-CANON-001: the Taste Picker's colour for its own genre). GENRE-ALL-001: it
 * says whether it is the main genre or a subgenre, and an estimate is drawn as one (a dashed outline,
 * never colour alone) and says where it came from.
 */
export function GenreBubbleView({ bubble: g }: { bubble: GenreBubble }) {
  const note = bubbleNote(g);
  return (
    <span
      className={classNames('genre', g.guess && 'genre--guess')}
      data-kind={g.sub ? 'sub' : 'main'}
      style={{ '--tone': g.color } as CSSProperties}
      {...(note ? { title: note } : {})}
      {...(g.guess && note ? { 'aria-label': `${g.label}, ${note.charAt(0).toLowerCase()}${note.slice(1)}` } : {})}
    >
      {g.label}
    </span>
  );
}

/**
 * ROW-CHECK-001: whether the song's file is on this device, as a drawn mark on the artwork corner. It was a
 * text character pinned to the row's corner, which landed on the Play button.
 */
const DL_ICON: Record<CacheState, GlyphName> = { ready: 'check', downloading: 'download', queued: 'history', failed: 'warning', blocked: 'error' };

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
  /** Adds only new songs whose analysed audio clears Settings' similarity threshold. */
  onSimilar?: (track: Track) => void;
  similarBusy?: boolean;
  /** Per-song cache state for the card rail; absent in contexts with no local downloader. */
  cacheOf?: (key: string) => CardCache | null;
  /** The listener's saved lists, for the menu that opens when a song is liked. */
  lists?: PlaylistSummary[];
  onLists?: (lists: PlaylistSummary[]) => void;
  /** ALBUM-OPEN-001: open the album a song is on. */
  onOpenAlbum?: ((t: Track) => void) | undefined;
  /** ARTIST-PAGE-001: each artist named on a card opens that artist's page. */
  onOpenArtist?: ((t: ArtistTarget) => void) | undefined;
}

/**
 * One list: starting songs first, then the discovery queue. Order of the queue is the server's
 * diversified order; nothing here re-sorts it.
 * Arrow keys / j k move between rows; Enter plays; the row keeps focus when results refresh.
 */
export function Results({ seeds, onRemoveSeed, onEmphasis, items, focusKey, playingKey, flags, onFocus, onPlay, onPlayTrack, onFeedback, onDownload, onSimilar, similarBusy, cacheOf, lists, onLists, onOpenAlbum, onOpenArtist }: Props) {
  /** Which row's save menu is showing, by song key. Only one opens at a time. */
  const [saving, setSaving] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ title: string; run: () => void } | null>(null);

  /**
   * SEED-DUPE-001: a song that is both a starting song and in the queue below is one song, so it
   * gets one row. The queue row is the one kept - it is the playable one, with its rank, cache
   * state and feedback - and it carries the starting-song marker and controls. The same recording
   * from another service counts as the same song, not a second one.
   */
  const sameSong = (a: Track, b: Track): boolean =>
    a.key === b.key || matchRecordings(a as never, b as never).verdict === 'same';
  const seedOf = (t: Track): Track | null => seeds.find((s) => sameSong(s, t)) ?? null;
  const seedRows = seeds.filter((s) => !items.some((it) => sameSong(it.track, s)));

  const move = (from: number, dir: 1 | -1) => {
    const next = items[from + dir];
    if (!next) return;
    onFocus(next.track.key);
    document.getElementById(rowId(next.track.key))?.focus();
  };

  return (
    <>
    <ol className="recs" aria-label="Now playing queue">
      {seedRows.map((s) => {
        const strong = (s.emphasis ?? 1) > 1;
        const pb = playbackOfTrack(s);
        const seedPlayable = canPlayHere(pb);
        const seedReady = cacheOf?.(s.key)?.state === 'ready';
        const sf = flags[s.key] ?? {};
        const seedItem = (items.find((x) => x.track.key === s.key) ?? { track: s, rank: 0, reasons: [], playback: playbackOfTrack(s), characteristics: s.characteristics ?? {} }) as RecItem;
        // GENRE-ALL-001: the engine sends a starting song's genres worked out; an older answer has only its tags.
        const seedBubbles = songTagBubbles(s.characteristics, s.tags);
        return (
          <SwipeLi key={`seed:${s.key}`} onRemove={() => onRemoveSeed(s.key)} onSwipeLeft={onLists ? () => setSaving(s.key) : undefined} className={classNames('rec', 'rec--seed', strong && 'is-strong', playingKey === s.key && 'is-playing')} onDoubleClick={seedPlayable ? playOnDoubleClick(() => onPlayTrack(s)) : undefined}>
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
              <Art src={s.artwork} size={ROW_COVER} />
              {seedPlayable && (
                <span className="rec__playover" aria-hidden="true">
                  <Glyph name="play" size={16} />
                </span>
              )}
            </button>
            <div className="rec__text">
              <Marquee className="rec__title" title={s.title}>{s.title}</Marquee>
              <SongCredits track={s} onOpenAlbum={onOpenAlbum} onOpenArtist={onOpenArtist} artistClassName="rec__artist" />
            </div>
            <div className="rec__sub">
              <span className="rec__why1">Starting song{strong ? ' · counts double' : ''}</span>
              {/* GENRE-LOAD-001: a starting song shows its genres like every other row. */}
              {seedBubbles.length > 0 && (
                <TagStrip className="rec__facts">
                  {seedBubbles.map((g) => <GenreBubbleView key={g.label} bubble={g} />)}
                </TagStrip>
              )}
            </div>
            <span className="rec__tier" />
            <span className="rec__dur" />
            <div className="rec__actions">
              {seedPlayable && (
                <RowPlayButton track={s} cache={seedReady ? ({ state: 'ready' } as CardCache) : null} onPlay={() => onPlayTrack(s)} />
              )}
              {/* STAR-MENU-001 / ROW-UNIFY-001: Play, star (saved-list menu), X, Download, Find similar - the
                  order of every song row - then the starting song's own "counts double". */}
              <button
                className={classNames('iconbtn', sf.like && 'is-on')}
                type="button"
                aria-pressed={Boolean(sf.like)}
                aria-expanded={onLists ? saving === s.key : undefined}
                onClick={() => {
                  if (!onLists) { onFeedback(seedItem, sf.like ? 'unlike' : 'like'); return; }
                  if (saving === s.key) { setSaving(null); return; }
                  if (!sf.like) onFeedback(seedItem, 'like');
                  setSaving(s.key);
                }}
                aria-label={`${sf.like ? `Liked: choose lists for ${s.title}` : `Like ${s.title} and choose lists`}${inPlaylist(s.key, lists) ? ' — saved to a playlist' : ''}`}
                title={`${sf.like ? 'Liked' : 'Like'}${inPlaylist(s.key, lists) ? ' — saved to a playlist' : ''}`}
              >
                <SongStar saved={inPlaylist(s.key, lists)} />
              </button>
              <button className="iconbtn" type="button" aria-label={`Remove ${s.title}`} title="Remove from the queue" onClick={() => onRemoveSeed(s.key)}>
                <Glyph name="close" size={14} />
              </button>
              {onDownload && (
                <button className="iconbtn" type="button" onClick={() => onDownload(s)} aria-label={`Download ${s.title}`} title="Download">
                  <Glyph name="download" size={14} />
                </button>
              )}
              {onSimilar && (
                <button className="iconbtn rec__similar" type="button" onClick={() => onSimilar(s)} disabled={similarBusy} aria-label={`Find similar sound to ${s.title}`} title="Find similar sound">
                  <SimilarGlyph size={16} />
                </button>
              )}
              <button
                className={classNames('iconbtn', strong && 'is-on')}
                type="button"
                aria-pressed={strong}
                title={strong ? 'Emphasised: counts double' : 'Emphasise this song (counts double)'}
                aria-label={strong ? `Stop emphasising ${s.title}` : `Emphasise ${s.title}`}
                onClick={() => onEmphasis(s.key, strong ? 1 : 2)}
              >
                <span className="emph-2x" aria-hidden="true">2×</span>
              </button>
            </div>
            {saving === s.key && onLists && (
              <div className="rec__savemenu">
                <SaveMenu songKey={s.key} title={s.title} lists={lists ?? []} onLists={onLists} onClose={() => setSaving(null)}
                  onUnstar={sf.like ? () => onFeedback(seedItem, 'unlike') : undefined} />
              </div>
            )}
          </SwipeLi>
        );
      })}
      {items.map((it, i) => {
        const t = it.track;
        const f = flags[t.key] ?? {};
        const playable = canPlayHere(it.playback);
        const facts = describeCharacteristics(it.characteristics);
        // One coloured bubble per genre or subgenre, no separators. The Taste Picker colour sits on the family/subgenre bubble.
        const bubbles = songTagBubbles(it.characteristics, t.tags);
        const toneFact = toneLabel(it.characteristics);
        const cache = cacheOf?.(t.key) ?? null;
        // SEED-DUPE-001: this queue row is also the starting song, so it says so and carries its controls.
        const seed = seedOf(t);
        const seedStrong = (seed?.emphasis ?? 1) > 1;
        const removeRow = () => {
          // The queue can display a starting song as a recommendation too. Removing that row
          // must clear both roles, or hiding the recommendation immediately reveals the seed.
          if (seed) onRemoveSeed(seed.key);
          onFeedback(it, 'hide');
        };
        return (
          <SwipeLi
            key={t.key}
            onRemove={removeRow}
            onSwipeLeft={onLists ? () => setSaving(t.key) : undefined}
            id={rowId(t.key)}
            className={classNames('rec', focusKey === t.key && 'is-focus', playingKey === t.key && 'is-playing', f.dislike && 'is-disliked')}
            data-dl={cache?.state}
            style={cache ? ({ '--dl': `${cache.progress}%` } as CSSProperties) : undefined}
            tabIndex={focusKey === t.key || (focusKey == null && i === 0) ? 0 : -1}
            aria-current={playingKey === t.key ? 'true' : undefined}
            onDoubleClick={playable ? playOnDoubleClick(() => onPlay(it)) : undefined}
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
            {cache && (
              // Never colour alone: the words are here, the drawn mark is on the artwork corner (ROW-CHECK-001).
              // The rail is decorative and sits on the bottom edge.
              <span className="rec__dl" data-dl={cache.state} data-indeterminate={cache.indeterminate || undefined}>
                <span className="rec__dl-rail" aria-hidden="true" />
                <span className="sr">{cache.keptText ? `${cache.text}. ${cache.keptText}.` : `${cache.text}.`}</span>
              </span>
            )}
            <span className="rec__rank" aria-hidden="true">
              {playingKey === t.key ? <Glyph name="speaker" size={12} /> : it.rank}
            </span>
            <button className="rec__art" type="button" onClick={() => (playable ? onPlay(it) : undefined)} disabled={!playable} aria-label={playable ? `Play ${t.title}` : `${t.title} has no player here`} tabIndex={-1}>
              <Art src={t.artwork} size={ROW_COVER} />
              {playable && (
                <span className="rec__playover" aria-hidden="true">
                  <Glyph name="play" size={16} />
                </span>
              )}
              {cache && (
                <span className="rec__dl-mark" data-dl={cache.state} aria-hidden="true">
                  <Glyph name={DL_ICON[cache.state]} size={10} />
                </span>
              )}
            </button>
            <div className="rec__text">
              <Marquee className="rec__title" title={t.title}>
                {t.title}
                {(t.versions ?? (t.version ? [t.version] : [])).map((v) => (
                  <span key={v} className="vtag">
                    {v}
                  </span>
                ))}
                {it.new_release && <span className="vtag vtag--new">New</span>}
              </Marquee>
              <SongCredits track={t} onOpenAlbum={onOpenAlbum} onOpenArtist={onOpenArtist} artistClassName="rec__artist" />
            </div>
            <div className="rec__sub">
              {seed && (
                <span className="rec__why1 rec__why1--seed">
                  <Glyph name="star" size={11} /> Starting song{seedStrong ? ' · counts double' : ''}
                </span>
              )}
              <span className="rec__why1">{it.reasons[0]?.text ?? 'Found from your starting songs.'}</span>
              {(bubbles.length > 0 || facts.length > 0) && (
                <TagStrip className="rec__facts">
                  {/* TAGS-CANON-001: each bubble in the Taste Picker's colour for its own genre. */}
                  {bubbles.map((g) => <GenreBubbleView key={g.label} bubble={g} />)}
                  {facts.map((f) => (
                    <span key={f} className="fact">
                      {f}
                    </span>
                  ))}
                </TagStrip>
              )}
            </div>
            <span className="rec__tier" title={`Evidence: ${it.evidence}`}>
              {TIER_LABEL[it.tier]}
            </span>
            <span className="rec__dur">{fmtDuration(t.duration)}</span>
            <div className="rec__actions">
              {playable && (
                <RowPlayButton track={t} cache={cache} onPlay={() => onPlay(it)} />
              )}
              <button
                className={classNames('iconbtn', f.like && 'is-on')}
                type="button"
                aria-pressed={Boolean(f.like)}
                aria-expanded={onLists ? saving === t.key : undefined}
                onClick={() => {
                  // STAR-MENU-001 (owner, 2026-11-19): the star always opens the saved-list menu. A first
                  // press also stars the song; a starred song is unstarred from the menu.
                  if (!onLists) { onFeedback(it, f.like ? 'unlike' : 'like'); return; }
                  if (saving === t.key) { setSaving(null); return; }
                  if (!f.like) onFeedback(it, 'like');
                  setSaving(t.key);
                }}
                aria-label={`${f.like ? (onLists ? `Liked: choose lists for ${t.title}` : `Remove like from ${t.title}`) : `Like ${t.title} and choose lists`}${inPlaylist(t.key, lists) ? ' — saved to a playlist' : ''}`}
                title={`${f.like ? 'Liked' : 'Like'}${inPlaylist(t.key, lists) ? ' — saved to a playlist' : ''}`}
              >
                <SongStar saved={inPlaylist(t.key, lists)} />
              </button>
              {/* DISLIKE-REMOVE-001 (owner, 2026-11-19): one button. Disliking teaches the algorithm and
                  takes the song out of the queue; the X that only hid it is gone. */}
              <button
                className={classNames('iconbtn', f.dislike && 'is-bad')}
                type="button"
                aria-pressed={Boolean(f.dislike)}
                onClick={() => {
                  if (f.dislike) { onFeedback(it, 'undislike'); return; }
                  const remove = () => { if (seed) onRemoveSeed(seed.key); onFeedback(it, 'dislike'); };
                  // REMOVE-CONFIRM-001: removing is for good, so the X asks first (unless told not to).
                  if (confirmRemoveWanted()) setConfirming({ title: t.title, run: remove });
                  else remove();
                }}
                aria-label={f.dislike ? `Undo dislike of ${t.title}` : `Dislike ${t.title} and remove it from the queue`}
                title={f.dislike ? 'Disliked' : 'Not for me — remove from the queue'}
              >
                <Glyph name="close" size={14} />
              </button>
              {onDownload && (
                <button className="iconbtn" type="button" onClick={() => onDownload(t)} aria-label={`Download ${t.title}`} title="Download">
                  <Glyph name="download" size={14} />
                </button>
              )}
              {/* SIMILAR-ICON-001: Find similar sound is an icon in the row, not a line of words. */}
              {onSimilar && (
                <button className="iconbtn rec__similar" type="button" onClick={() => onSimilar(t)} disabled={similarBusy} aria-label={`Find similar sound to ${t.title}`} title="Find similar sound">
                  <SimilarGlyph size={16} />
                </button>
              )}
              {/* STAR-MENU-001: the star is only ever the save menu; "counts double" is its own 2× button. */}
              {seed && (
                <>
                  <button
                    className={classNames('iconbtn', seedStrong && 'is-on')}
                    type="button"
                    aria-pressed={seedStrong}
                    title={seedStrong ? 'Emphasised: counts double' : 'Emphasise this starting song'}
                    aria-label={seedStrong ? `Stop emphasising ${t.title}` : `Emphasise ${t.title}`}
                    onClick={() => onEmphasis(seed.key, seedStrong ? 1 : 2)}
                  >
                    <span className="emph-2x" aria-hidden="true">2×</span>
                  </button>
                  <button
                    className="iconbtn"
                    type="button"
                    title="Stop using this as a starting song"
                    aria-label={`Stop ${t.title} being a starting song`}
                    onClick={() => onRemoveSeed(seed.key)}
                  >
                    <Glyph name="close" size={14} />
                  </button>
                </>
              )}
            </div>
            {saving === t.key && onLists && (
              <div className="rec__savemenu">
                <SaveMenu songKey={t.key} title={t.title} lists={lists ?? []} onLists={onLists} onClose={() => setSaving(null)}
                  onUnstar={f.like ? () => onFeedback(it, 'unlike') : undefined} />
              </div>
            )}
          </SwipeLi>
        );
      })}
    </ol>
    {confirming && (
      <ConfirmRemove title={confirming.title} onCancel={() => setConfirming(null)} onConfirm={() => { const run = confirming.run; setConfirming(null); run(); }} />
    )}
    </>
  );
}


export function rowId(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return `rec-${(h >>> 0).toString(36)}`;
}
