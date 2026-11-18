import { clampSlider, requestedSeconds } from './crossfade';
import type { AudioBus, DeckId } from './audio-bus';

export interface MixCandidate { key: string; preview?: string | null }
const what = (url: string): 'full song' | 'preview' =>
  url.startsWith('/local-audio') || url.startsWith('blob:') ? 'full song' : 'preview';

/** FULL-COMPLETION-001: only a short entrance AFTER the preceding source finished. */
export const entranceSeconds = (slider: number, duration: number): number =>
  Math.min(2, requestedSeconds(clampSlider(slider)), Number.isFinite(duration) && duration > 0 ? duration * 0.1 : 2);

/** A preloaded second deck, silent until active.ended; cues or old settings cannot shorten a song. */
export class PreviewMixer {
  active: DeckId = 'a';
  private generation = 0;
  private candidate: MixCandidate | null = null;
  private ready = false;
  private pending = false;

  constructor(
    private readonly decks: Record<DeckId, HTMLAudioElement>,
    private readonly bus: () => AudioBus | null,
    private readonly resolve: (url: string) => Promise<string>,
    private readonly status: (text: string) => void,
  ) {}
  get other(): DeckId { return this.active === 'a' ? 'b' : 'a'; }
  get overlapping(): boolean { return false; }

  private clear(restore: boolean): void {
    this.generation += 1;
    const wasPending = this.pending;
    this.pending = this.ready = false;
    this.candidate = null;
    const spare = this.decks[this.other];
    spare.pause(); spare.removeAttribute('src'); spare.load();
    // Preloading the following song must not erase the current song's entrance automation.
    if (restore || wasPending) this.bus()?.cut(this.active);
  }
  cancel(): void { this.clear(true); }
  /** Seeking current playback is not a reason to throw away a correctly preloaded next source. */
  seeked(): void { if (this.pending) this.cancel(); else this.bus()?.cut(this.active); }

  async prepare(next: MixCandidate | null): Promise<void> {
    if (next?.key === this.candidate?.key && next?.preview === this.candidate?.preview) return;
    this.clear(false);
    if (!next?.preview) { this.status('No next song queued.'); return; }
    this.candidate = next;
    const generation = this.generation, incoming = this.decks[this.other];
    this.status('Preparing the next song…');
    try {
      const url = await this.resolve(next.preview);
      if (generation !== this.generation) return;
      incoming.src = url; incoming.playbackRate = 1; incoming.preservesPitch = true;
      incoming.load(); this.ready = true;
      this.status(`Ready for the next ${what(url)} — after 100% of this song.`);
    } catch {
      if (generation === this.generation) this.status('Next song unavailable; current song continues.');
    }
  }

  /** Playhead ticks deliberately cannot start another song, regardless of saved play-through. */
  async tick(_slider: number, _savedPlayThrough?: number): Promise<void> {}

  /** Natural end only; metadata promotion follows a successfully started source, never preloading. */
  async handoff(slider: number): Promise<{ key: string; deck: DeckId } | null> {
    const outgoing = this.decks[this.active], target = this.other, incoming = this.decks[target];
    const bus = this.bus();
    if (!clampSlider(slider) || !bus || !outgoing.ended || outgoing.seeking || this.pending ||
        !this.ready || !this.candidate || incoming.readyState < 3 || incoming.error) return null;
    const candidate = this.candidate, generation = this.generation;
    this.pending = true;
    bus.cut(this.active); // incoming must be silent before play, never dipped afterward
    incoming.currentTime = 0; incoming.playbackRate = 1; incoming.preservesPitch = true;
    try {
      await incoming.play();
      if (generation !== this.generation) return null; // cancel already stopped the obsolete deck
      if (incoming.paused || incoming.ended || incoming.error) { incoming.pause(); return null; }
      const seconds = entranceSeconds(slider, incoming.duration);
      if (seconds > 0) bus.transitionTo(target, seconds, 'blend'); else bus.cut(target);
      outgoing.pause(); this.active = target; this.generation += 1;
      this.candidate = null; this.ready = false;
      this.status(seconds > 0 ? `Full song completed · ${seconds.toFixed(1)}s entrance · ${what(incoming.currentSrc || incoming.src)}` : 'Full song completed · clean handoff.');
      return { key: candidate.key, deck: target };
    } catch {
      if (generation === this.generation) { incoming.pause(); bus.cut(this.active); this.status('Next song could not start.'); }
      return null;
    } finally {
      if (generation === this.generation || this.active === target) this.pending = false;
    }
  }
}
