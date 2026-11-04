/**
 * The ONNX session (port of audio.py's Encoder). onnxruntime-web is injected so tests can use the same
 * package under node and the WebView can point it at the bundled wasm files.
 */
import { DIM, SR, estimateBpm, logMel, meanNormalise, segmentsOf, segmentsSpread, trimSilence, N_MELS } from './audio';

export interface OrtTensorLike {
  data: Float32Array | ArrayLike<number>;
}
export interface OrtSessionLike {
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensorLike>>;
}
export interface OrtLike {
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => unknown;
  InferenceSession: {
    create(model: Uint8Array | string, options?: Record<string, unknown>): Promise<OrtSessionLike>;
  };
}

export interface EmbedResult {
  vector: Float32Array;
  segments: number;
  seconds: number;
  inferMs: number;
}

/** What one decoded preview yields: its tempo and, when asked, its embedding. */
export interface Analysis {
  /** The clip was shorter than 5 s once silence was trimmed; nothing else is set. */
  tooShort: boolean;
  bpm: number | null;
  vector: Float32Array | null;
  inferMs: number;
  /** How many windows the embedding averaged, so its provenance can be recorded. */
  segments?: number;
  /** Seconds of audio actually analysed, after silence was trimmed. */
  seconds?: number;
}

/** The analysis step, shared by the in-thread Encoder and the proxy for the worker that hosts one. */
export interface Analyser {
  analyse(y: Float32Array, embed: boolean, maxSegments?: number): Promise<Analysis>;
}

export class Encoder implements Analyser {
  private session: Promise<OrtSessionLike> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  error: string | null = null;

  constructor(
    private readonly ort: OrtLike,
    /** Returns the bytes of model_epoch_36.onnx and of model_epoch_36.onnx.data. */
    private readonly loadModel: () => Promise<{ model: Uint8Array; data: Uint8Array }>,
    private readonly sessionOptions: Record<string, unknown> = {},
  ) {}

  private load(): Promise<OrtSessionLike> {
    this.session ??= (async () => {
      const { model, data } = await this.loadModel();
      return this.ort.InferenceSession.create(model, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
        externalData: [{ path: 'model_epoch_36.onnx.data', data }],
        ...this.sessionOptions,
      });
    })().catch((e: unknown) => {
      this.session = null;
      this.error = e instanceof Error ? e.message : String(e);
      throw e;
    });
    return this.session;
  }

  /** Trim, measure tempo and (optionally) embed one decoded clip. Heavy: run it off the UI thread. */
  async analyse(decoded: Float32Array, embed: boolean, maxSegments?: number): Promise<Analysis> {
    const y = trimSilence(decoded);
    if (y.length < SR * 5) return { tooShort: true, bpm: null, vector: null, inferMs: 0 };
    const bpm = estimateBpm(y);
    if (!embed) return { tooShort: false, bpm, vector: null, inferMs: 0 };
    const r = await this.embedAudio(y, undefined, maxSegments);
    return { tooShort: false, bpm, vector: r.vector, inferMs: r.inferMs, segments: r.segments, seconds: r.seconds };
  }

  /**
   * One worker: calls are serialised, as the Python Encoder's lock does.
   *
   * `maxSegments` bounds how many windows are run for a long signal, spread across the whole of it
   * (FULL-SONG-EMBED-001). Omit it and every hop is analysed, which is what the preview path does.
   */
  embedAudio(y: Float32Array, onSegment?: (done: number, total: number) => void, maxSegments?: number): Promise<EmbedResult> {
    const run = this.chain.then(async () => {
      const sess = await this.load();
      const t = performance.now();
      const embs: Float32Array[] = [];
      const segs = maxSegments && maxSegments > 0 ? segmentsSpread(y, maxSegments) : segmentsOf(y);
      for (const seg of segs) {
        const { data, frames } = logMel(seg);
        const out = await sess.run({ mel_spectrogram: new this.ort.Tensor('float32', data, [1, 1, N_MELS, frames]) });
        const first = Object.values(out)[0]!;
        const v = Float32Array.from(first.data as ArrayLike<number>);
        if (v.length !== DIM) throw new Error(`The model returned ${v.length} values, expected ${DIM}.`);
        embs.push(v);
        onSegment?.(embs.length, segs.length);
      }
      return { vector: meanNormalise(embs), segments: segs.length, seconds: y.length / SR, inferMs: performance.now() - t };
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}
