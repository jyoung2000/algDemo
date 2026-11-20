// CAR-RADIO-ADOPT-001 (found on the Android Auto head unit, 2026-11-20): with the phone app open in the background, a
// station started from the car played but the car showed only "Live on V103" and the phone no radio player. The phone
// page looked for a native radio session once, when it opened; the car's session started later. It now looks every
// 5 s, as the service page does when the phone app is closed.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('the phone page adopts a radio session the car started', () => {
  it('checks for a native session every 5 s while open, and stops when it closes', () => {
    const app = readFileSync(resolve(process.cwd(), 'src', 'App.tsx'), 'utf8');
    expect(app).toMatch(/useEffect\(\(\) => \{\s*void radioSession\.restore\(\);\s*const t = setInterval\(\(\) => void radioSession\.restore\(\), 5000\);\s*return \(\) => clearInterval\(t\);\s*\}, \[\]\);/);
  });
  it('restore is cheap when a session is already shown (one early return, no request)', () => {
    const rc = readFileSync(resolve(process.cwd(), 'src', 'engine', 'radio-client.ts'), 'utf8');
    expect(rc).toMatch(/async restore\(\) \{\s*if \(this\.value\.station\) return;/);
  });
});
