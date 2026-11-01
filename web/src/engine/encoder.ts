/**
 * The ONNX session (port of audio.py's Encoder). onnxruntime-web is injected so tests can use the same
 * package under node and the WebView can point it at the bundled wasm files.
 */
import { DIM, SR, logMel, meanNormalise, segmentsOf, N_MELS } from './audio';

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

export class Encoder {
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

  /** One worker: calls are serialised, as the Python Encoder's lock does. */
  embedAudio(y: Float32Array, onSegment?: (done: number, total: number) => void): Promise<EmbedResult> {
    const run = this.chain.then(async () => {
      const sess = await this.load();
      const t = performance.now();
      const embs: Float32Array[] = [];
      const segs = segmentsOf(y);
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
