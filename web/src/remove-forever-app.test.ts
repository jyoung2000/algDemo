// REMOVE-FOREVER-001 (owner, 2026-11-20): removing a song also removes the app's downloaded copy of it.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const app = readFileSync(resolve(process.cwd(), 'src', 'App.tsx'), 'utf8');
describe('removing a song deletes its cached file', () => {
  it('asks the shell to evict the song\'s cache link right after the removal is stored', () => {
    expect(app).toMatch(/if \(kind === 'hide' \|\| kind === 'dislike'\) \{[\s\S]{0,300}queueAudio\.sourceHint\(track\)[\s\S]{0,200}dl\.evict\(/);
  });
});
