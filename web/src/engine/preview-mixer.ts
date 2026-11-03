import { MIN_USEFUL_SECONDS, mixPlan } from './crossfade';
import type { AudioBus, DeckId } from './audio-bus';

export interface MixCandidate { key: string; preview?: string | null }

/** MIXER-003: cancellable lookahead and overlap. The two elements live for the player's lifetime.
 * BPM metadata is NOT a measured beat grid. These transitions do not claim beat/phrase alignment.
 * The outgoing song remains the current song until it ends; promotion keeps the incoming playhead.
 */
export class PreviewMixer {
  active: DeckId = 'a';
  private generation = 0;
  private candidate: MixCandidate | null = null;
  private ready = false;
  private pending = false;
  private running = false;
  private failed = false;

  constructor(
    private readonly decks: Record<DeckId, HTMLAudioElement>,
    private readonly bus: () => AudioBus | null,
    private readonly resolve: (url: string) => Promise<string>,
    private readonly status: (text: string) => void,
  ) {}

  get other(): DeckId { return this.active === 'a' ? 'b' : 'a'; }
  get overlapping(): boolean { return this.running; }

  cancel(): void {
    this.generation += 1;
    this.pending = this.running = this.ready = this.failed = false;
    this.candidate = null;
    const spare = this.decks[this.other];
    spare.pause();
    spare.removeAttribute('src');
    spare.load();
    this.bus()?.cut(this.active);
  }

  async prepare(next: MixCandidate | null): Promise<void> {
    if (next?.key === this.candidate?.key && next?.preview === this.candidate?.preview) return;
    this.cancel();
    if (!next?.preview) { this.status('No mixable next preview; normal handoff.'); return; }
    this.candidate = next;
    const generation = this.generation;
    const incoming = this.decks[this.other];
    this.status('Preparing the next preview…');
    try {
      const url = await this.resolve(next.preview);
      if (generation !== this.generation) return;
      incoming.src = url;
      incoming.playbackRate = 1;
      incoming.preservesPitch = true;
      incoming.load();
      this.ready = true;
      this.status('Ready to blend the next preview.');
    } catch {
      if (generation !== this.generation) return;
      this.failed = true;
      this.status('Next preview unavailable; normal handoff.');
    }
  }

  async tick(slider: number): Promise<void> {
    if (!slider || this.pending || this.running || this.failed || !this.ready) return;
    const outgoing = this.decks[this.active], incoming = this.decks[this.other];
    const bus = this.bus();
    if (!bus || outgoing.paused || outgoing.seeking || incoming.readyState < 3) return;
    const plan = mixPlan(slider, outgoing.duration, incoming.duration);
    if (!plan.seconds || outgoing.currentTime < plan.startAt || outgoing.ended) return;
    const generation = this.generation;
    const target = this.other;
    this.pending = true;
    // The spare must be inaudible before play() — never start at full volume then fade it down.
    bus.cut(this.active);
    incoming.currentTime = 0;
    try {
      await incoming.play();
      if (generation !== this.generation) {
        // cancel() already paused this element. Do not pause it again: a later generation may
        // have reused it for a new song while this old play promise was settling.
        return;
      }
      const remaining = Math.min(plan.seconds, outgoing.duration - outgoing.currentTime);
      if (outgoing.paused || outgoing.ended || remaining < MIN_USEFUL_SECONDS) {
        incoming.pause(); this.failed = true; return;
      }
      bus.transitionTo(target, remaining, plan.style);
      this.running = true;
      this.status(`${plan.label} · ${remaining.toFixed(1)}s ${plan.style.replace('-', ' ')} · previews`);
    } catch {
      if (generation === this.generation) {
        incoming.pause(); this.failed = true;
        bus.cut(this.active);
        this.status('Next preview could not start; normal handoff.');
      }
    } finally {
      if (generation === this.generation) this.pending = false;
    }
  }

  /** Called once when the outgoing song ends; never restarts the already-playing incoming song. */
  finish(): { key: string; deck: DeckId } | null {
    const incoming = this.decks[this.other];
    if (!this.running || !this.candidate || incoming.paused || incoming.ended || incoming.readyState < 3) {
      this.cancel();
      return null;
    }
    const result = { key: this.candidate.key, deck: this.other };
    this.decks[this.active].pause();
    this.active = this.other;
    this.generation += 1;
    this.candidate = null;
    this.ready = this.pending = this.running = this.failed = false;
    this.bus()?.cut(this.active);
    this.status('Blend complete.');
    return result;
  }
}
