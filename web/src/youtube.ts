/**
 * YouTube's own IFrame Player API, loaded on demand. Airwave never fetches or re-streams the audio:
 * the full song plays inside YouTube's embedded player, and this API only gives the page play, pause,
 * seek, volume and progress for it. Only the pieces Airwave uses are typed here.
 */
export interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  setVolume(volume: number): void;
  mute(): void;
  unMute(): void;
  getCurrentTime(): number;
  getDuration(): number;
  /** -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued. */
  getPlayerState(): number;
  loadVideoById(videoId: string): void;
  destroy(): void;
}

export interface YTNamespace {
  Player: new (
    frame: HTMLIFrameElement,
    options: {
      events: {
        onReady?: () => void;
        onStateChange?: (e: { data: number }) => void;
        onError?: (e: { data: number }) => void;
      };
    },
  ) => YTPlayer;
}

type YTWindow = Window & { YT?: YTNamespace; onYouTubeIframeAPIReady?: () => void };

let loading: Promise<YTNamespace> | null = null;

/** Resolves once `window.YT.Player` exists. A failed load can be retried by calling again. */
export function loadYouTube(): Promise<YTNamespace> {
  const w = window as YTWindow;
  if (w.YT?.Player) return Promise.resolve(w.YT);
  if (loading) return loading;
  loading = new Promise<YTNamespace>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('The YouTube player did not load in time.')), 12000);
    const previous = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      previous?.();
      window.clearTimeout(timer);
      if (w.YT?.Player) resolve(w.YT);
      else reject(new Error('The YouTube player did not start.'));
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error('The YouTube player could not be loaded.'));
    };
    document.head.appendChild(s);
  }).catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

/** The embed address for one video. `enablejsapi` is what lets the page control it. */
export function youtubeEmbedUrl(videoId: string): string {
  const origin = encodeURIComponent(window.location.origin);
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?enablejsapi=1&autoplay=1&playsinline=1&rel=0&origin=${origin}`;
}
