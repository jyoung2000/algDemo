import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The Saved page's list switcher is built in SavedView.tsx and styled in saved-lists.css.
// These checks read both, so a change that brings back the wrapping rows, the removed "Add"
// button, or a text field inside the swipe scroller fails here.
const here = dirname(fileURLToPath(import.meta.url));
const view = readFileSync(join(here, 'SavedView.tsx'), 'utf8');
const css = readFileSync(join(here, 'saved-lists.css'), 'utf8');
const app = readFileSync(join(here, 'App.tsx'), 'utf8');

describe('the Saved page list switcher (PLAYLISTS-001)', () => {
  it('keeps every list on one swipeable row on a phone', () => {
    const phone = css.slice(css.indexOf('@media (max-width: 899px)'));
    expect(phone).toMatch(/\.lists__scroll \{[^}]*flex-wrap: nowrap;/);
    expect(phone).toMatch(/\.lists__scroll \{[^}]*overflow-x: auto;/);
    expect(phone).toMatch(/\.lists__scroll \{[^}]*scroll-snap-type: x proximity;/);
    // A pill that shrinks is unreadable; swiping is how the rest of the row is reached.
    expect(phone).toMatch(/\.lists__tab,\s*\.lists__add \{[^}]*flex: 0 0 auto;/);
    expect(phone).toMatch(/\.lists__tab,\s*\.lists__add \{[^}]*scroll-snap-align: start;/);
  });

  it('does not clip the focus ring inside the scroll box', () => {
    // overflow:auto would otherwise cut the outline off the top and bottom of a focused pill.
    const phone = css.slice(css.indexOf('@media (max-width: 899px)'));
    expect(phone).toMatch(/\.lists__scroll \{[^}]*padding: 3px 0;/);
    expect(css).toMatch(/\.lists__tab:focus-visible,\s*\.lists__add:focus-visible \{[^}]*outline: 2px solid/);
  });

  it('puts the new-list field outside the scroller, where it can be typed into', () => {
    expect(view).toMatch(/className="lists__create"/);
    // The field must not be a child of the sideways scroller.
    const scroller = view.slice(view.indexOf('className="lists__scroll"'), view.indexOf('</div>\n      </div>'));
    expect(scroller).not.toMatch(/className="field"/);
    expect(css).toMatch(/\.lists__create \.field \{[^}]*min-height: 44px;/);
  });

  it('scrolls a newly created list into view, since it is appended past the edge', () => {
    expect(view).toMatch(/scrollTo\(\{ left: el\.scrollWidth/);
  });

  it('has no "Add" button on the Saved page any more', () => {
    // The owner asked for it to go: a saved song is not a starting song.
    expect(view).not.toMatch(/>\s*Add\s*</);
    expect(view).not.toMatch(/addbtn/);
    // And App.tsx no longer renders the old inline Saved list that carried it.
    const savedBlock = app.slice(app.indexOf("tab === 'saved'"), app.indexOf("tab === 'profile'"));
    expect(savedBlock).not.toMatch(/addbtn/);
    expect(savedBlock).toMatch(/<SavedView/);
  });

  it('gives every list control a 44px target', () => {
    expect(css).toMatch(/\.lists__tab,\s*\.lists__add \{[^}]*min-height: 44px;/);
  });

  it('tells the listener why a list is or is not being topped up', () => {
    expect(view).toMatch(/still to play\. Discovery waits until you have heard them all\./);
    expect(view).toMatch(/You have played everything here, so discovery may add to it\./);
  });

  it('passes the list a play came from, so the engine applies that list’s rule', () => {
    expect(view).toMatch(/onPreview\(track, current\?\.id\)/);
    expect(app).toMatch(/playingListRef\.current = listId \?\? null;/);
    expect(app).toMatch(/list_id: playingListRef\.current \?\? undefined/);
    // Playing from the queue must drop the list, or the queue would inherit its stricter rule.
    expect(app).toMatch(/playingListRef\.current = null;/);
  });
});
