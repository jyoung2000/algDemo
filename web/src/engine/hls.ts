// The pinned, locally bundled hls.js full build attaches MSE to our permanent audio deck.
// It never creates another media element: WebAudio EQ and mixer stay on the same element.
type HlsInstance = {
  loadSource(url: string): void;
  attachMedia(media: HTMLMediaElement): void;
  on(event: string, callback: (_event: string, data: { fatal?: boolean }) => void): void;
  destroy(): void;
};
type HlsConstructor = { new(): HlsInstance; isSupported(): boolean; Events: { ERROR: string; MANIFEST_PARSED: string } };
let loading: Promise<HlsConstructor> | null = null;
function library(): Promise<HlsConstructor> {
  if (!loading) loading = new Promise<HlsConstructor>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/hls.min.js';
    script.onload = () => {
      const ctor = (window as Window & { Hls?: HlsConstructor }).Hls;
      if (ctor) resolve(ctor);
      else reject(new Error('The bundled HLS player did not load.'));
    };
    script.onerror = () => reject(new Error('The bundled HLS player could not load.'));
    document.head.append(script);
  }).catch((e: unknown) => { loading = null; throw e; });
  return loading;
}

export function startHls(media: HTMLAudioElement, source: string, failed: () => void): () => void {
  let live = true;
  let instance: HlsInstance | null = null;
  const abort = new AbortController();
  void (async () => {
    try {
      const Hls = await library();
      if (!live) return;
      if (!Hls.isSupported()) throw new Error('MSE audio is unavailable.');
      const response = await fetch(`/hls-info?u=${encodeURIComponent(source)}`, { signal: abort.signal });
      if (!response.ok) throw new Error('No HLS audio playlist.');
      const { url } = await response.json() as { url: string };
      if (!live || !/^\/hls-resource\?/.test(url)) return;
      instance = new Hls();
      instance.on(Hls.Events.ERROR, (_event, data) => { if (live && data.fatal) failed(); });
      instance.on(Hls.Events.MANIFEST_PARSED, () => {
        if (live) void media.play().catch(() => { /* user can press Play */ });
      });
      instance.loadSource(url);
      instance.attachMedia(media);
    } catch {
      if (live) failed();
    }
  })();
  return () => { live = false; abort.abort(); instance?.destroy(); };
}
