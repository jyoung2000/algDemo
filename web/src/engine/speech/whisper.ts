/**
 * VOICE-SEARCH-001. Owner: "allow the user to voice search song names using the same mic icon they can
 * search for songs via song lyrics". Speech to text on the device, offline, with Whisper tiny.en
 * (Xenova's quantized ONNX export, MIT) through onnxruntime-web: the same code in the Android WebView
 * and the Windows app. Greedy decoding with Whisper's own suppressed tokens and no timestamps.
 */
import { logMel, N_FRAMES, N_MELS } from './mel';

export interface SpeechTensor { data: Float32Array | BigInt64Array; dims: readonly number[] }
export interface SpeechSession { run(feeds: Record<string, unknown>, fetches?: string[]): Promise<Record<string, SpeechTensor>> }
export interface SpeechOrt {
  Tensor: new (type: 'float32' | 'int64', data: Float32Array | BigInt64Array, dims: number[]) => unknown;
  InferenceSession: { create(model: Uint8Array, opts?: Record<string, unknown>): Promise<SpeechSession> };
}
export interface GenerationConfig {
  decoder_start_token_id: number;
  eos_token_id: number;
  no_timestamps_token_id: number;
  suppress_tokens: number[];
  begin_suppress_tokens: number[];
}
export interface WhisperFiles { encoder: Uint8Array; decoder: Uint8Array; vocab: Record<string, number>; generation: GenerationConfig }

/** Where the page fetches the model from: shipped beside the audio model in both apps. */
export const WHISPER_DIR = '/models/whisper-tiny.en/';
const FIRST_SPECIAL = 50257;
const MAX_TOKENS = 48;

/** GPT-2's byte-level alphabet: each byte is drawn as one printable character in the vocabulary. */
function byteDecoder(): Map<string, number> {
  const bs: number[] = [];
  for (let b = 33; b <= 126; b++) bs.push(b);
  for (let b = 161; b <= 172; b++) bs.push(b);
  for (let b = 174; b <= 255; b++) bs.push(b);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++) if (!bs.includes(b)) { bs.push(b); cs.push(256 + n++); }
  return new Map(bs.map((b, i) => [String.fromCharCode(cs[i]!), b]));
}

export class Whisper {
  private ready: Promise<{ enc: SpeechSession; dec: SpeechSession; tokens: string[]; bytes: Map<string, number>; gen: GenerationConfig }> | null = null;
  constructor(private readonly ort: SpeechOrt, private readonly load: () => Promise<WhisperFiles>) {}

  private open() {
    return (this.ready ??= (async () => {
      const f = await this.load();
      const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
      const [enc, dec] = await Promise.all([this.ort.InferenceSession.create(f.encoder, opts), this.ort.InferenceSession.create(f.decoder, opts)]);
      const tokens: string[] = [];
      for (const [t, id] of Object.entries(f.vocab)) tokens[id] = t;
      return { enc, dec, tokens, bytes: byteDecoder(), gen: f.generation };
    })().catch((e) => { this.ready = null; throw e; }));
  }

  /** Warm the sessions while the person is still talking, so the words come back sooner. */
  prepare(): Promise<unknown> { return this.open(); }

  /** The words in up to 30 s of 16 kHz mono audio; '' when none were heard. */
  async transcribe(samples: Float32Array, signal?: AbortSignal): Promise<string> {
    const { enc, dec, tokens, bytes, gen } = await this.open();
    const features = new this.ort.Tensor('float32', logMel(samples), [1, N_MELS, N_FRAMES]);
    const hidden = (await enc.run({ input_features: features }, ['last_hidden_state']))['last_hidden_state']!;
    const encoded = new this.ort.Tensor('float32', hidden.data as Float32Array, [...hidden.dims]);
    const suppress = new Set(gen.suppress_tokens);
    const ids = [gen.decoder_start_token_id, gen.no_timestamps_token_id];
    for (let step = 0; step < MAX_TOKENS; step++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const input = new this.ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]);
      const out = (await dec.run({ input_ids: input, encoder_hidden_states: encoded }, ['logits']))['logits']!;
      const v = out.dims[2]!;
      const logits = out.data as Float32Array;
      const base = (ids.length - 1) * v;
      let best = -1, top = -Infinity;
      for (let t = 0; t < v; t++) {
        if (suppress.has(t) || (step === 0 && gen.begin_suppress_tokens.includes(t))) continue;
        const x = logits[base + t]!;
        if (x > top) { top = x; best = t; }
      }
      if (best === gen.eos_token_id || best < 0) break;
      ids.push(best);
    }
    const raw: number[] = [];
    for (const id of ids.slice(2)) {
      if (id >= FIRST_SPECIAL) continue;
      for (const ch of tokens[id] ?? '') { const b = bytes.get(ch); if (b !== undefined) raw.push(b); }
    }
    return new TextDecoder().decode(new Uint8Array(raw)).trim();
  }
}

/**
 * What a spoken search becomes in the search box: Whisper's sentence punctuation and the "by" of
 * "Bohemian Rhapsody by Queen" are dropped, and the filler Whisper writes for silence or music
 * ("[Music]", "(upbeat music)", "♪") means nothing was said.
 */
export function queryFromSpeech(text: string): string {
  const t = text
    .replace(/\[[^\]]*\]|\([^)]*\)|♪+/g, ' ')
    .replace(/[.!?,;:"“”]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/[\p{L}\p{N}]/u.test(t)) return '';
  if (/^(you|thank you|thanks for watching)$/i.test(t)) return '';
  return t.replace(/^(play|search for|search|find)\s+/i, '').slice(0, 200);
}
