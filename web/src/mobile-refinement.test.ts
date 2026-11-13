import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { historyStops } from './TasteHistory';
import type { Snapshot } from './taste-view';

const css = readFileSync(new URL('./mobile-refinement.css', import.meta.url), 'utf8');
const ticker = readFileSync(new URL('./GenreTicker.tsx', import.meta.url), 'utf8');
const actions = readFileSync(new URL('./PlayerActions.tsx', import.meta.url), 'utf8');
const history = readFileSync(new URL('./TasteHistory.tsx', import.meta.url), 'utf8');
const card = readFileSync(new URL('./SoundCard.tsx', import.meta.url), 'utf8');

const snap = (segs: { slug: string; share: number; label?: string; color?: string }[]): Snapshot => ({ t: 1, events: 3, segs });

describe('taste history is a blended field, not columns', () => {
  it('places each colour at the middle of its share so neighbours blend', () => {
    const stops = historyStops(snap([
      { slug: 'hip-hop', share: 0.5, color: '#a' },
      { slug: 'pop', share: 0.5, color: '#b' },
    ]));
    expect(stops.map((s) => s.color)).toEqual(['#a', '#b']);
    // Outer stops are pulled to the ends so no flat block reads as a box.
    expect(stops[0]!.at).toBeLessThanOrEqual(8);
    expect(stops[1]!.at).toBeGreaterThanOrEqual(92);
  });

  it('ignores zero and non-finite shares rather than drawing an invisible band', () => {
    const stops = historyStops(snap([
      { slug: 'hip-hop', share: 1, color: '#a' },
      { slug: 'pop', share: 0, color: '#b' },
      { slug: 'rock', share: Number.NaN, color: '#c' },
    ]));
    expect(stops).toHaveLength(1);
  });

  it('falls back to the family colour for updates saved before labels were recorded', () => {
    expect(historyStops(snap([{ slug: 'hip-hop', share: 1 }]))[0]!.color).toMatch(/^(#|hsl|oklch|rgb)/);
  });

  it('blurs across columns and keeps the exact shares in a readout, not in the picture', () => {
    expect(history).toMatch(/feGaussianBlur/);
    expect(history).toContain('Blended colours; exact saved shares below.');
    expect(history).toMatch(/Math\.round\(s\.share \* 100\)/);
  });

  it('lets the user inspect an update, and follows the newest state until they do', () => {
    expect(history).toMatch(/type="range"/);
    expect(history).toMatch(/aria-label="Inspect taste history"/);
    expect(history).toMatch(/useState<number \| null>\(null\)/);
  });
});

describe('the Your sound header marquees the genres, most to least dominant (TICKER-MARQUEE-001)', () => {
  it('scrolls one continuous line rather than swapping one genre at a time', () => {
    // The owner asked for a marquee that scrolls THROUGH the genres, so the line is the whole
    // ordered run of them, not a single entry replaced on a timer.
    expect(card).toContain('<GenreTicker entries={view?.leaves ?? []} />');
    expect(ticker).toMatch(/genre-ticker__track/);
    expect(ticker).toMatch(/entries\.map/);
    // Two passes of the same run, so the scroll can wrap with no visible gap.
    expect(ticker).toMatch(/aria-hidden="true"[\s\S]*?entries\.map|entries\.map[\s\S]*?aria-hidden="true"/);
  });

  it('keeps the order the taste view already computed: strongest genre first', () => {
    // soundView() sorts leaves by pct descending, so the marquee must not re-sort or reverse them.
    expect(ticker).not.toMatch(/\.sort\(|\.reverse\(/);
    expect(ticker).toMatch(/entries\.map\(\(/);
  });

  it('drives the scroll from the number of genres so the pace does not depend on the count', () => {
    // A fixed duration would crawl with twelve genres and race with two.
    expect(ticker).toMatch(/--ticker-duration/);
    expect(css).toMatch(/@keyframes ticker-scroll/);
    expect(css).toMatch(/\.genre-ticker__track \{[\s\S]*?animation: ticker-scroll/);
  });

  it('holds still for reduced motion, a hidden tab, hover or focus', () => {
    expect(ticker).toMatch(/prefers-reduced-motion: reduce/);
    expect(ticker).toMatch(/const still = focused \|\| hovered \|\| hidden \|\| reduced;/);
    // Paused, not unmounted: the genres stay readable when the marquee stops.
    expect(ticker).toMatch(/still && 'is-still'/);
    expect(css).toMatch(/\.genre-ticker\.is-still \.genre-ticker__track \{[\s\S]*?animation-play-state: paused/);
  });

  it('still reads as a list to a screen reader instead of a smear of duplicated text', () => {
    // The rendered proof (one exposed list, each genre once, in order) is in GenreTicker.test.tsx,
    // which can use JSX. Here: only the first pass carries the roles, the duplicate is hidden.
    expect(ticker).toMatch(/role: 'list'/);
    expect(ticker).toMatch(/role: 'listitem'/);
    expect(ticker).toMatch(/'aria-hidden': 'true'/);
  });

  it('restarts at the strongest genre when the mix itself changes', () => {
    expect(ticker).toMatch(/signature/);
    expect(ticker).toMatch(/key=\{signature\}/);
  });
});

describe('the Songs header keeps Clear list cleanly on the right (QUEUE-HEAD-001)', () => {
  it('orders the row heading, status, then the action, and pins the action to the right edge', () => {
    // The owner, on the desktop: the button sat a third of the way across the row with 200px of
    // nothing on either side — a three-item space-between row with the action stranded in the
    // middle. The row is heading · status (left, together), action (right, always).
    const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
    const main = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
    // In both headers (results, and seeds only) the button comes after everything else.
    for (const m of app.matchAll(/<div className="queue__head">([\s\S]*?)<\/div>\s*(?:<Results|\{running)/g)) {
      const head = m[1]!;
      const button = head.indexOf('Clear now playing queue');
      const meta = head.indexOf('queue__meta');
      expect(button).toBeGreaterThan(-1);
      if (meta > -1) expect(button).toBeGreaterThan(meta);
    }
    expect(main).toMatch(/\.queue__head \{[^}]*justify-content: flex-start;/);
    expect(main).toMatch(/\.queue__head > \.push \{[^}]*margin-left: auto;/);
  });
});

describe('the taste map trail shows distinct songs (TASTE-MAP-DISTINCT)', () => {
  it('plots each song once, at its latest play, so one song on repeat is one tile', () => {
    // The owner: "not show the same cover art over and over". Ten plays of one song (repeat-one)
    // were ten tiles of one cover. The trail is the last ten DISTINCT songs played.
    const profile = readFileSync(new URL('./Profile.tsx', import.meta.url), 'utf8');
    expect(profile).toMatch(/const seenKeys = new Set<string>\(\);/);
    expect(profile).toMatch(/if \(seenKeys\.has\(s\.key\)\) return false;/);
    expect(profile).toMatch(/\.slice\(0, 10\)/);
  });

  it('draws every marker from the zoom-scaled size, the ringed current song a third larger (TASTE-MAP-SCALE)', () => {
    const main = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
    expect(main).toMatch(/\.tpick__step \{[^}]*width: var\(--tp-marker, 42px\);[^}]*height: var\(--tp-marker, 42px\);/);
    expect(main).toMatch(/\.tpick__step--now \{[^}]*calc\(var\(--tp-marker, 42px\) \* 4 \/ 3\)/);
  });
});

describe('the Your sound ticker has no play/pause button', () => {
  it('still rests on hover, focus, a hidden tab and reduced motion, with no control at all', () => {
    // The owner asked for the play/pause button to go, and TICKER-MARQUEE-001 then replaced the
    // one-at-a-time swap with a continuous scroll, which leaves nothing for a "next" button to do.
    // The a11y intent is unchanged: the marquee holds still under the pointer, under focus, in a
    // hidden tab and under reduced motion — it is simply paused rather than stepped.
    expect(ticker).not.toMatch(/Pause genre rotation/);
    expect(ticker).not.toMatch(/name=\{paused \? 'play' : 'pause'\}/);
    expect(ticker).not.toMatch(/<button/);
    expect(ticker).toMatch(/const still = focused \|\| hovered \|\| hidden \|\| reduced;/);
  });
});

describe('the player carries like, dislike and download for the song playing', () => {
  it('labels each control and shows which are on', () => {
    for (const label of ['Like this song', 'Dislike this song', 'Download this song']) expect(actions).toContain(label);
    expect(actions).toMatch(/aria-pressed=\{Boolean\(flags\.like\)\}/);
  });

  it('cannot fire twice at once and says so when a request fails', () => {
    expect(actions).toMatch(/if \(pending\.current\) return;/);
    expect(actions).toContain('Could not save. Try again.');
    expect(actions).toContain('Download failed. Open Downloads to retry.');
  });

  it('turns into a way to see the file once the download is running or done', () => {
    expect(actions).toMatch(/downloadState === 'done' \|\| downloadState === 'working'/);
    expect(actions).toMatch(/name=\{downloadState === 'done' \? 'check' : 'download'\}/);
  });
});

describe('the controls are flat and reachable', () => {
  it('gives every quiet control a 44px target, no gloss and a visible press', () => {
    expect(css).toMatch(/\.quiet-control \{[^}]*min-width: 44px;[^}]*min-height: 44px;/);
    expect(css).toMatch(/\.quiet-control \{[^}]*background: transparent;/);
    expect(css).toMatch(/\.quiet-control:active:not\(:disabled\) \{[^}]*transform: scale\(0\.94\);/);
    expect(css).toMatch(/\.quiet-control:focus-visible \{[^}]*outline: 2px solid var\(--focus\);/);
  });

  it('keeps the phone action buttons inside the dock row', () => {
    expect(css).toMatch(/@media \(max-width: 899px\) \{[\s\S]*?\.np--docked \.np__track-actions \{[^}]*flex: 0 0 auto;/);
  });

  /**
   * Measured on the device at 412px: with the actions on their own third grid row the dock stood
   * 200px tall and read as a separate toolbar. They now sit in .np__controls beside the transport
   * and the volume, which brought the dock to 154px.
   */
  it('puts the song actions in the controls row, not a row of their own', () => {
    const player = readFileSync(new URL('./Player.tsx', import.meta.url), 'utf8');
    const docked = /<div className="np__dockctl">([\s\S]*?)\n            <\/div>/.exec(player);
    expect(docked, 'docked dock markup not found').toBeTruthy();
    const controls = /<div className="np__controls">([\s\S]*?)<\/div>/.exec(docked![1]!);
    expect(controls, 'np__controls not found in the docked layout').toBeTruthy();
    expect(controls![1]).toContain('<PlayerActions');
  });

  it('keeps shuffle and repeat on the phone dock; the room comes from the volume slider, not the toggles (DOCK-SHUFFLE-001)', () => {
    // Owner, from a phone screenshot: no shuffle anywhere in the dock. An earlier rule hid both
    // toggles under 900px to fit the row. The row now fits because a phone sets its level with
    // the hardware rocker: on narrow phones the dock keeps the mute button and drops the slider.
    expect(css).not.toMatch(/\.np--docked \.transport \.tbtn--mode \{[^}]*display: none;/);
    expect(css).toMatch(/@media \(max-width: 599px\) \{[\s\S]*?\.np--docked \.np__controls \.vol__bar \{[^}]*display: none;/);
    expect(css).toMatch(/@media \(max-width: 599px\) \{[\s\S]*?\.np--docked \.np__controls \.vol \{[^}]*min-width: 0;/);
  });

  it('draws the search list’s actions with the song list’s icon buttons: round, flat, no Add pill (SEARCH-ICONS-001)', () => {
    const search = readFileSync(new URL('./Search.tsx', import.meta.url), 'utf8');
    const row = /<span className="track__actions">([\s\S]*?)<\/span>/.exec(search);
    expect(row, 'track__actions not found').toBeTruthy();
    expect(row![1]).not.toContain('addbtn');
    // Same action and flat touch target; STAR-PLAYLIST-001 changes only the mark, not its behavior.
    expect(row![1]).toMatch(/className=\{classNames\('iconbtn', added && 'is-on'\)\}[\s\S]*?aria-pressed=\{added\}[\s\S]*?<SongStar saved=\{inPlaylist\(t.key, lists\)\} \/>/);
    expect(row![1]).not.toMatch(/name=\{added \? 'check' : 'add'\}/);
    // Same paint as .rec__actions: one shared rule set in the main stylesheet.
    const main = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
    expect(main).toMatch(/\.rec__actions \.iconbtn,\s*\.track__actions \.iconbtn \{/);
    expect(main).toMatch(/\.rec__actions \.iconbtn:hover,\s*\.track__actions \.iconbtn:hover \{/);
    expect(main).toMatch(/\.rec__actions \.iconbtn\[aria-pressed='true'\],\s*\.track__actions \.iconbtn\[aria-pressed='true'\] \{/);
  });

  it('drops the dock volume entirely on a very narrow phone, where the rocker is the volume (DOCK-SHUFFLE-001)', () => {
    expect(css).toMatch(/@media \(max-width: 379px\) \{[\s\S]*?\.np--docked \.np__controls \.vol \{[^}]*display: none;/);
  });

  it('drops the panel around the search sliders on a phone only', () => {
    expect(css).toMatch(/@media \(max-width: 899px\) \{\s*\.go \{[^}]*box-shadow: none;/);
  });

  it('stops its own animations when the user asks for less motion', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*animation: none;/);
  });
});
