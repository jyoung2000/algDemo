import type { Analyser, Analysis } from './encoder';

type Reply = { id: number; ok?: Analysis; error?: string };

/** Proxy for the audio worker: same `analyse` as the Encoder, but the work runs on another thread. */
export class WorkerEncoder implements Analyser {
  private next = 1;
  private readonly waiting = new Map<number, { res: (a: Analysis) => void; rej: (e: Error) => void }>();

  constructor(private readonly worker: Worker, urls: { wasm: string; mjs: string }) {
    worker.onmessage = (e: MessageEvent<Reply>) => {
      const w = this.waiting.get(e.data.id);
      if (!w) return;
      this.waiting.delete(e.data.id);
      if (e.data.ok) w.res(e.data.ok);
      else w.rej(new Error(e.data.error ?? 'audio worker failed'));
    };
    worker.onerror = (e) => this.failAll(new Error(e.message || 'audio worker crashed'));
    worker.onmessageerror = () => this.failAll(new Error('audio worker sent an unreadable message'));
    worker.postMessage({ init: urls });
  }

  private failAll(err: Error): void {
    for (const w of this.waiting.values()) w.rej(err);
    this.waiting.clear();
  }

  analyse(y: Float32Array, embed: boolean): Promise<Analysis> {
    const id = this.next++;
    return new Promise<Analysis>((res, rej) => {
      this.waiting.set(id, { res, rej });
      // The samples move to the worker rather than being copied.
      this.worker.postMessage({ id, y, embed }, [y.buffer]);
    });
  }
}
