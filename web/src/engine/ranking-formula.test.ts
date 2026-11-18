import { describe, expect, it } from 'vitest';
import { applyRankingFormula, compileRankingFormula, DEFAULT_RANKING_FORMULA, parseRankingFormula, rankingInputs } from './ranking-formula';
const input = rankingInputs(0.6, 0.8, 0.7, { genre: 0.9, audio: null, novelty: 1 });
describe('bounded maths parser', () => {
  it.each([
    ['1 + 2 * 3', 1 + 2 * 3], ['(1 + 2) * 3', (1 + 2) * 3], ['2 ^ 3 ^ 2', 2 ** (3 ** 2)],
    ['-2 ^ 2', -(2 ** 2)], ['2 ^ -2', 2 ** -2], ['.5e-1 + 1.', 0.05 + 1],
    ['clamp(2 * genre, 0, 1)', 1], ['min(genre, 1, .5)', 0.5],
    ['max(abs(-.4), sqrt(.25), pow(.5, 2))', 0.5], ['log(1)', 0],
    ['has_audio * audio + genre', 0.9],
  ])('evaluates %s with ordinary maths precedence', (source, expected) => {
    expect(compileRankingFormula(String(source)).evaluate(input)).toBeCloseTo(Number(expected));
  });
  it.each(['window', 'globalThis.fetch(1)', 'Math.max(1,2)', 'constructor(1)', '1 constructor 2', '1 toString 2', 'base.__proto__', 'base[0]', 'base;1', 'while(1)', '1=1', 'true', 'unknown', '"genre"', 'min()', 'abs(1,2)', '1 / 0', '1e309', '1e308 * 1e308', 'sqrt(-1)', 'genre +', '1,2', '()'])('rejects code, malformed input or nonfinite result: %s', source => {
    expect(() => compileRankingFormula(source)).toThrow();
  });
  it('bounds size, token count and parser recursion', () => {
    for (const source of ['1'.repeat(2049), '1+'.repeat(257) + '1', '('.repeat(33) + '1' + ')'.repeat(33), '-'.repeat(34) + '1']) expect(() => compileRankingFormula(source)).toThrow();
  });
  it('exposes missing evidence explicitly instead of inventing values', () => {
    expect(input).toMatchObject({ audio: 0, has_audio: 0, genre: 0.9, has_genre: 1, taste: 0, has_taste: 0 });
  });
  it('preserves the exact default, supports reset, and clamps custom scores', () => {
    expect(parseRankingFormula(null)).toBeNull(); expect(parseRankingFormula('  ')).toBeNull(); expect(parseRankingFormula(DEFAULT_RANKING_FORMULA)).toBeNull();
    expect(parseRankingFormula('  genre  ')).toBe('genre');
    expect(applyRankingFormula('5', input).score).toBe(1); expect(applyRankingFormula('-1', input).score).toBe(0);
    expect(compileRankingFormula(DEFAULT_RANKING_FORMULA).evaluate(input)).toBe(input.affinity! * (input.coverage_floor! + (1 - input.coverage_floor!) * input.coverage!));
  });
  it('guards domain errors at actual song inputs, even if validation probes passed', () => {
    const value = rankingInputs(0.6, 0.8, 0.7, { audio: 0.25 });
    const result = applyRankingFormula('1/(audio - 0.25)', value);
    expect(result.score).toBe(0.6); expect(result.error).toMatch(/finite/);
  });
});
