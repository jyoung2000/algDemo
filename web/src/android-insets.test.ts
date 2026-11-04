/**
 * The app's content never sits under the Android status bar (ANDROID-INSETS-001).
 *
 * The owner saw the top row overlap the clock on a real phone. The cause is Android 15: at
 * targetSdk 35 the system draws every app edge to edge and refuses to be told otherwise, so the
 * WebView fills the whole screen including the status-bar strip. There is no CSS-only fix, because
 * a WebView whose host view was never told about the insets reports `env(safe-area-inset-top)` as
 * zero. The native side has to read the insets and pay for them.
 *
 * These checks read MainActivity.kt and styles.css so a later change cannot quietly drop any part
 * of the arrangement and bring the overlap back. The live proof (the inset the window reports and
 * where the page's first row lands) is in references/verifying-on-devices.md.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url);
const kt = readFileSync(new URL('android/app/src/main/java/com/nowplaying/discovery/MainActivity.kt', root), 'utf8');
const gradle = readFileSync(new URL('android/app/build.gradle.kts', root), 'utf8');
const css = readFileSync(new URL('web/src/styles.css', root), 'utf8');

describe('Android status bar insets (ANDROID-INSETS-001)', () => {
  it('asks for edge to edge itself instead of waiting for the platform to force it', () => {
    // Opting in from API 30 means an API 34 emulator runs the same path the phone does, so the
    // overlap is reproducible and testable rather than only visible on the owner's device.
    expect(kt).toMatch(/private fun edgeToEdge\(\)/);
    expect(kt).toMatch(/Build\.VERSION\.SDK_INT < 30\) return/);
    expect(kt).toMatch(/window\.setDecorFitsSystemWindows\(false\)/);
    expect(kt).toMatch(/onCreate[\s\S]{0,400}?edgeToEdge\(\)/);
  });

  it('pads the root view with the inset the window reports, cutout included', () => {
    // Read from the window, never a hard-coded dimen: a notch, a hole punch and a plain 24dp bar
    // are all different heights, and only the window knows which this phone has.
    expect(kt).toMatch(/setOnApplyWindowInsetsListener/);
    expect(kt).toMatch(/Type\.systemBars\(\) or android\.view\.WindowInsets\.Type\.displayCutout\(\)/);
    expect(kt).toMatch(/v\.setPadding\(bars\.left, bars\.top, bars\.right,/);
    expect(kt).toMatch(/root\.requestApplyInsets\(\)/);
    expect(kt).not.toMatch(/setPadding\([^)]*\b(24|48|136)\b/);
  });

  it('keeps the keyboard out from under the page once decor no longer fits system windows', () => {
    // setDecorFitsSystemWindows(false) also opts out of adjustResize, so the bottom padding has to
    // take the IME into account or the search field hides under the keyboard it just opened.
    expect(kt).toMatch(/Type\.ime\(\)/);
    expect(kt).toMatch(/maxOf\(bars\.bottom, ime\.bottom\)/);
    expect(/android:windowSoftInputMode="adjustResize"/.test(readFileSync(new URL('android/app/src/main/AndroidManifest.xml', root), 'utf8'))).toBe(true);
  });

  it('consumes the insets so the page is not charged for the bars twice', () => {
    // The padding is the single place the bars are paid for. If the insets were passed on, the
    // stylesheet's env(safe-area-inset-bottom) terms would add the navigation bar a second time.
    expect(kt).toMatch(/android\.view\.WindowInsets\.CONSUMED/);
    expect(kt).not.toMatch(/setOnApplyWindowInsetsListener[\s\S]{0,600}?\n\s*insets\n/);
  });

  it('leaves breathing room under the bar so the first row is not flush against the clock', () => {
    // The inset clears the bar; this padding is the gap below it the owner asked for. It was 10px
    // and the owner asked for more after seeing it on a real phone, so the floor is what matters:
    // assert a value, and that it is at least 24px, rather than pinning one exact number.
    const rule = /@media \(max-width: 899px\) \{\s*\.app \{[\s\S]*?padding: (\d+)px 12px 24px;/.exec(css);
    expect(rule).not.toBeNull();
    expect(Number(rule![1])).toBeGreaterThanOrEqual(24);
  });

  it('still targets the SDK that forces edge to edge, so this stays the real path', () => {
    expect(gradle).toMatch(/targetSdk = 3[5-9]/);
  });
});
