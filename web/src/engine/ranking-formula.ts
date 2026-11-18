/** RANK-FORMULA-001. Bounded arithmetic, not JavaScript. No eval, property access or I/O. */
export const DEFAULT_RANKING_FORMULA = 'affinity * (coverage_floor + (1 - coverage_floor) * coverage)';
export const MAX_FORMULA_LENGTH = 2048;
export const FORMULA_FACTORS = ['audio', 'genre', 'artist', 'provider', 'feedback', 'tempo', 'freshness', 'novelty', 'taste'] as const;
export const FORMULA_VARIABLES = ['base', 'affinity', 'coverage', 'coverage_floor', ...FORMULA_FACTORS, ...FORMULA_FACTORS.map(k => `has_${k}`)];
const variables = new Set(FORMULA_VARIABLES);
type Inputs = Record<string, number>;
type Expr = (inputs: Inputs) => number;
const finite = (value: number): number => {
  if (!Number.isFinite(value)) throw new Error('Formula must give a finite number. Guard division and square roots.');
  return value;
};
const functions: Record<string, { min: number; max: number; run: (...args: number[]) => number }> = {
  min: { min: 2, max: 16, run: Math.min }, max: { min: 2, max: 16, run: Math.max },
  abs: { min: 1, max: 1, run: Math.abs }, sqrt: { min: 1, max: 1, run: Math.sqrt },
  pow: { min: 2, max: 2, run: Math.pow }, log: { min: 1, max: 1, run: Math.log },
  clamp: { min: 3, max: 3, run: (value, low, high) => Math.min(high!, Math.max(low!, value!)) },
};
export interface CompiledRankingFormula { evaluate: (inputs: Inputs) => number; variables: string[] }
const cache = new Map<string, CompiledRankingFormula>();

export function compileRankingFormula(source: string): CompiledRankingFormula {
  if (typeof source !== 'string') throw new Error('Formula must be text.');
  if (source.length > MAX_FORMULA_LENGTH) throw new Error(`Formula is limited to ${MAX_FORMULA_LENGTH} characters.`);
  const text = source.trim();
  const cached = cache.get(text); if (cached) return cached;
  if (!text) throw new Error('Enter a formula or use the default.');
  const tokens: string[] = [];
  const token = /\s*(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z0-9_]*|[+\-*/^(),])/y;
  for (let at = 0; at < text.length;) {
    token.lastIndex = at; const match = token.exec(text);
    if (!match) throw new Error(`Unexpected character at position ${at + 1}. Only maths expressions are allowed.`);
    tokens.push(match[1]!); at = token.lastIndex;
    if (tokens.length > 512) throw new Error('Formula is too complex (512 tokens maximum).');
  }
  let at = 0; const used = new Set<string>();
  const precedence: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 4 };
  const expect = (value: string) => { if (tokens[at++] !== value) throw new Error(`Expected “${value}”.`); };
  const expression = (minimum = 0, depth = 0): Expr => {
    if (depth > 32) throw new Error('Formula is nested too deeply (32 levels maximum).');
    const next = tokens[at++]; let left: Expr;
    if (next === '+' || next === '-') {
      const inner = expression(3, depth + 1); left = next === '-' ? input => finite(-inner(input)) : inner;
    } else if (next === '(') {
      left = expression(0, depth + 1); expect(')');
    } else if (next && /^(\d|\.)/.test(next)) {
      const value = finite(Number(next)); left = () => value;
    } else if (next && /^[A-Za-z_]/.test(next)) {
      if (tokens[at] === '(') {
        if (!Object.hasOwn(functions, next)) throw new Error(`Unknown function “${next}”.`);
        at++; const args: Expr[] = [];
        if (tokens[at] !== ')') {
          do { args.push(expression(0, depth + 1)); if (tokens[at] !== ',') break; at++; } while (true);
        }
        expect(')'); const fn = functions[next]!;
        if (args.length < fn.min || args.length > fn.max) throw new Error(`${next} needs ${fn.min === fn.max ? fn.min : `${fn.min}–${fn.max}`} arguments.`);
        left = input => finite(fn.run(...args.map(arg => arg(input))));
      } else {
        if (!variables.has(next)) throw new Error(`Unknown variable “${next}”.`);
        used.add(next); left = input => finite(input[next]!);
      }
    } else throw new Error('Expected a number, variable or parenthesised expression.');
    while (at < tokens.length) {
      const op = tokens[at]!; const level = Object.hasOwn(precedence, op) ? precedence[op] : undefined;
      if (level === undefined || level < minimum) break;
      at++; const right = expression(op === '^' ? level : level + 1, depth + 1); const previous = left;
      left = input => {
        const a = previous(input), b = right(input);
        return finite(op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : op === '/' ? a / b : Math.pow(a, b));
      };
    }
    return left;
  };
  const evaluate = expression();
  if (at !== tokens.length) throw new Error(`Unexpected token “${tokens[at]}”.`);
  // These probes catch common domain mistakes; arbitrary inputs still get a runtime guard.
  for (const value of [0, 0.5, 1]) {
    const probe = Object.fromEntries(FORMULA_VARIABLES.map(k => [k, k === 'coverage_floor' ? 0.55 : k.startsWith('has_') ? Number(value > 0) : value]));
    evaluate(probe);
  }
  const result = { evaluate, variables: [...used] };
  cache.set(text, result); if (cache.size > 16) cache.delete(cache.keys().next().value!);
  return result;
}

/** Null/blank/default resets the override. Reject non-string values rather than coercing code. */
export function parseRankingFormula(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('Formula must be text or null to reset.');
  if (value.length > MAX_FORMULA_LENGTH) throw new Error(`Formula is limited to ${MAX_FORMULA_LENGTH} characters.`);
  const source = value.trim();
  if (!source || source === DEFAULT_RANKING_FORMULA) return null;
  compileRankingFormula(source); return source;
}
export function rankingInputs(base: number, affinity: number, coverage: number, factors: Record<string, number | null>, coverageFloor = 0.55): Inputs {
  const input: Inputs = { base, affinity, coverage, coverage_floor: coverageFloor };
  for (const key of FORMULA_FACTORS) {
    const value = factors[key]; const known = typeof value === 'number' && Number.isFinite(value);
    input[key] = known ? Math.min(1, Math.max(0, value)) : 0;
    input[`has_${key}`] = Number(known);
  }
  return input;
}
export function applyRankingFormula(source: string, input: Inputs): { score: number; error?: string } {
  try { return { score: Math.min(1, Math.max(0, compileRankingFormula(source).evaluate(input))) }; }
  catch (e) { return { score: input.base!, error: (e as Error).message }; }
}
