import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PREVIEW_ROUTE, previewRoute } from './engine/shape';

const player = readFileSync(new URL('./Player.tsx', import.meta.url), 'utf8');
const art = readFileSync(new URL('./Art.tsx', import.meta.url), 'utf8');
const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');

describe('a Deezer preview is resolved to a signed URL before it plays', () => {
  it('keeps the stable route in the catalogue, not a signed address', () => {
    expect(previewRoute({ provider: 'deezer', platform_id: '122703266' })).toBe(`${PREVIEW_ROUTE}122703266`);
  });

  it('exchanges that route for a playable URL, because an <audio> element cannot play it', () => {
    // Proven on the device: assigning the route itself gives media error 4,
    // DEMUXER_ERROR_COULD_NOT_OPEN, since the shell answers that path with the app's own page.
    expect(api).toMatch(/previewUrl: \(route: string\) => call<\{ url: string \}>\(route\.replace\('\/api\/preview\/', '\/api\/preview-url\/'\)\)/);
    expect(player).toMatch(/if \(src\.startsWith\(PREVIEW_ROUTE\)\) \{/);
    expect(player).toMatch(/api\.previewUrl\(src\)\.then\(/);
  });

  it('never lets a late answer hijack the player after the song changed', () => {
    expect(player).toMatch(/if \(!live \|\| audio\.current !== a\) return;/);
    expect(player).toMatch(/return \(\) => \{\s*live = false;\s*\};/);
  });

  it('says so when the preview cannot be reached, instead of sitting silent', () => {
    expect(player).toContain('This preview could not be reached.');
  });

  it('still plays an address that is already playable', () => {
    expect(player).toMatch(/\} else begin\(src\);/);
  });
});

describe('artwork recovers when its source changes', () => {
  it('remembers the failure against the URL that failed, not the component', () => {
    expect(art).toMatch(/useState<string \| null>\(null\)/);
    expect(art).toMatch(/const broken = Boolean\(src\) && failed === src;/);
    expect(art).toMatch(/onError=\{\(\) => setFailed\(src\)\}/);
  });
});
